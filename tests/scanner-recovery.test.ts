import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { Store } from "../server/store.ts";
import { scan } from "../server/scanner.ts";
import type { Context } from "../server/parser.ts";

const hash = (v: unknown) =>
  createHash("sha256").update(String(v)).digest("hex");
const record = (id: string) =>
  JSON.stringify({
    type: "token_usage_record",
    timestamp: "2026-10-16T00:00:00Z",
    payload: {
      response_id: id,
      usage: {
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
        total_tokens: 11,
      },
    },
  }) + "\n";
function fixture() {
  const dir = mkdtempSync(`${tmpdir()}/quotascope-scanner-recovery-`);
  const logs = join(dir, "logs");
  mkdirSync(logs);
  return { logs, store: new Store(join(dir, "usage.sqlite")) };
}

test("a storage failure rolls back the chunk and retries records with matching parser context", async () => {
  const { logs, store } = fixture(),
    file = join(logs, "a.jsonl");
  // Put a committed record in the first chunk and a context change in the failing chunk.
  const first = record("first");
  const padding =
    JSON.stringify({
      type: "ignored",
      padding: "x".repeat(65536 - first.length - 32),
    }) + "\n";
  const context =
    JSON.stringify({
      type: "session_meta",
      payload: { id: "thread", creator_account_id: "second-account" },
    }) + "\n";
  const content =
    first + padding + context + record("second") + record("third");
  writeFileSync(file, content);
  const event = store.event.bind(store);
  let failed = false;
  store.event = (value) => {
    if (value.account === hash("second-account") && !failed) {
      failed = true;
      throw Error("Injected transient storage failure");
    }
    event(value);
  };
  try {
    await assert.rejects(scan(store, hash, [logs]), /incomplete/i);
    assert.equal(store.events().length, 1);
    assert.equal(
      store.cursor<Context>(hash(file))?.account,
      "unattributed-local",
    );
    assert.equal(
      store.issues().some((i) => i.code === "malformed-record"),
      false,
    );
    assert.equal(store.get<{ complete: boolean }>("scan")?.complete, false);
    store.event = event;
    await scan(store, hash, [logs]);
    assert.equal(store.events().length, 3);
    assert.equal(
      store.events().filter((e) => e.account === hash("second-account")).length,
      2,
    );
    assert.equal((await scan(store, hash, [logs])).bytes, 0);
    assert.equal(readFileSync(file, "utf8"), content);
  } finally {
    store.close();
  }
});

test("partial discovery failures preserve good-file progress and report an incomplete import", async () => {
  const { logs, store } = fixture();
  const badRoot = join(logs, "not-a-directory");
  writeFileSync(badRoot, "fixture");
  writeFileSync(join(logs, "good.jsonl"), record("good"));
  try {
    await assert.rejects(scan(store, hash, [badRoot, logs]), /incomplete/i);
    assert.equal(store.events().length, 1);
    assert.equal(store.get<{ complete: boolean }>("scan")?.complete, false);
    await scan(store, hash, [logs]);
    assert.equal(store.events().length, 1);
    assert.equal(store.get<{ complete: boolean }>("scan")?.complete, true);
  } finally {
    store.close();
  }
});

test("cursor write failures roll back data writes without hiding progress from other files", async () => {
  const { logs, store } = fixture(),
    file = join(logs, "a.jsonl");
  writeFileSync(file, record("a"));
  writeFileSync(join(logs, "b.jsonl"), record("b"));
  const save = store.saveCursor.bind(store);
  let failed = false;
  store.saveCursor = (key, value) => {
    if (!failed) {
      failed = true;
      throw Error("Injected cursor write failure");
    }
    save(key, value);
  };
  try {
    await assert.rejects(scan(store, hash, [logs]), /incomplete/i);
    assert.equal(store.events().length, 1);
    store.saveCursor = save;
    await scan(store, hash, [logs]);
    assert.equal(store.events().length, 2);
    assert.equal((await scan(store, hash, [logs])).bytes, 0);
  } finally {
    store.close();
  }
});

test("a discovered file that moves before reading is retried without losing other files", async () => {
  const { logs, store } = fixture();
  for (const name of ["a", "b", "c"])
    writeFileSync(join(logs, name + ".jsonl"), record(name));
  const b = join(logs, "b.jsonl"),
    moved = join(logs, "..", "retained-b.jsonl");
  const cursor = store.cursor.bind(store);
  let movedOnce = false;
  store.cursor = <T>(key: string) => {
    if (!movedOnce) {
      movedOnce = true;
      renameSync(b, moved);
    }
    return cursor<T>(key);
  };
  try {
    await assert.rejects(scan(store, hash, [logs]), /incomplete/i);
    assert.equal(store.events().length, 2);
    renameSync(moved, b);
    await scan(store, hash, [logs]);
    assert.equal(store.events().length, 3);
    assert.equal((await scan(store, hash, [logs])).bytes, 0);
  } finally {
    store.close();
  }
});

test("old cursors replay once and recover a previously skipped record without duplicating saved data", async () => {
  const { logs, store } = fixture(),
    file = join(logs, "a.jsonl");
  writeFileSync(file, record("saved") + record("previously-skipped"));
  const event = store.event.bind(store);
  let written = false;
  store.event = (value) => {
    if (!written) {
      event(value);
      written = true;
    }
  };
  try {
    await scan(store, hash, [logs]);
    assert.equal(store.events().length, 1);
    const cursor = store.cursor<Context>(hash(file))!;
    store.saveCursor(hash(file), { ...cursor, parser: 3 });
    store.event = event;
    await scan(store, hash, [logs]);
    assert.equal(store.events().length, 2);
    assert.equal(store.cursor<Context>(hash(file))!.parser, 4);
    assert.equal((await scan(store, hash, [logs])).bytes, 0);
  } finally {
    store.close();
  }
});

test("an overlapping writer is allowed to commit before the importer begins its write transaction", async () => {
  const { logs, store } = fixture();
  writeFileSync(join(logs, "a.jsonl"), record("concurrent"));
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData);
    db.exec("BEGIN IMMEDIATE; INSERT OR REPLACE INTO meta VALUES ('concurrent-test', 'true')");
    parentPort.postMessage('locked');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);
  `,
    { eval: true, workerData: store.path },
  );
  const exited = once(worker, "exit");
  try {
    await once(worker, "message");
    const report = await scan(store, hash, [logs]);
    assert.equal(report.complete, true);
    assert.equal(store.events().length, 1);
    assert.equal(store.get("concurrent-test"), true);
  } finally {
    await exited;
    store.close();
  }
});
