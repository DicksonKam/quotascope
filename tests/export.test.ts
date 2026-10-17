import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { Store } from "../server/store.ts";
import { writeExport } from "../server/export-data.ts";
import type { Observation, TokenEvent } from "../shared/types.ts";

test("streamed JSON/CSV preserve export values, provenance, quoting, timezone and a consistent snapshot", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "quotascope-export-data-")),
    "fixture.sqlite",
  );
  const store = new Store(path);
  const at = Date.UTC(2026, 0, 2, 3, 4, 5);
  const observation: Observation = {
    account: "synthetic",
    bucket: "codex",
    slot: "primary",
    at,
    used: 42,
    reset: 1800000000,
    duration: 300,
    plan: "test",
    source: "account",
    resetCredits: null,
    balance: null,
  };
  const event: TokenEvent = {
    key: "response",
    account: "synthetic",
    thread: "thread",
    session: "session",
    device: "device",
    at,
    model: "test",
    effort: "medium",
    speed: "standard",
    input: 100,
    cached: 20,
    cacheWrite: null,
    output: 10,
    reasoning: 2,
    total: 110,
    kind: "response",
    flags: [],
  };
  store.observe(observation);
  store.observe({ ...observation, at: at + 1, source: "manual" });
  store.observe({ ...observation, at: at + 2, source: "local" });
  store.event(event);
  store.annotate({
    account: "synthetic",
    kind: "plan",
    label: 'quoted "note", preserved',
    at,
    end: at + 1000,
    verified: true,
  });
  store.issue("fixture", "malformed-record");
  const reader = new Store(path, true);
  async function collect(format: "json" | "csv") {
    let text = "";
    await writeExport(
      reader.db,
      format,
      new Writable({
        write(chunk, _encoding, callback) {
          text += chunk.toString();
          callback();
        },
      }),
      at,
    );
    return text;
  }
  try {
    const json = JSON.parse(await collect("json"));
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.generatedAt, "2026-01-02T03:04:05.000Z");
    assert.equal(json.timezone, "Asia/Hong_Kong");
    assert.deepEqual(
      json.observations.map((o: any) => o.evidence),
      ["provider-observation", "user-observation", "local-log-observation"],
    );
    assert.deepEqual(json.observations[0], {
      ...observation,
      utc: new Date(at).toISOString(),
      hongKong: new Date(at).toLocaleString("en-GB", {
        timeZone: "Asia/Hong_Kong",
      }),
      evidence: "provider-observation",
    });
    assert.deepEqual(json.events[0], {
      ...event,
      utc: new Date(at).toISOString(),
      hongKong: "02/01/2026, 11:04:05",
      evidence: "local-response-metadata",
    });
    assert.deepEqual(json.annotations, store.annotations());
    assert.deepEqual(json.issues, [{ code: "malformed-record", count: 1 }]);
    const csv = await collect("csv");
    assert.equal(csv.split("\r\n").length, 5);
    assert.equal(
      csv.split("\r\n")[0],
      '"recordType","schemaVersion","account","thread","bucket","slot","utc","hongKong","used","duration","reset","plan","source","evidence","model","effort","speed","input","cached","cacheWrite","output","reasoning","total","quality"',
    );
    assert.equal(
      csv.split("\r\n")[4],
      '"response","1","synthetic","thread","","","2026-01-02T03:04:05.000Z","02/01/2026, 11:04:05","","","","","local","local-response-metadata","test","medium","standard","100","20","","10","2","110","coverage-incomplete"',
    );
    // Force multiple buffered writes and a concurrent commit between exported tables.
    store.db.exec("BEGIN");
    for (let i = 1; i < 1500; i++)
      store.observe({ ...observation, at: at + i });
    for (let i = 0; i < 600; i++)
      store.observe({ ...observation, bucket: `same-time-${i}` });
    for (let i = 0; i < 260; i++)
      store.annotate({
        account: "synthetic",
        kind: "coverage",
        label: String(i),
        at,
        end: at + 1000,
        verified: true,
      });
    store.db.exec("COMMIT");
    let chunks = 0,
      maxChunk = 0,
      text = "";
    await writeExport(
      reader.db,
      "json",
      new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
          chunks++;
          maxChunk = Math.max(maxChunk, chunk.length);
          text += chunk.toString();
          if (chunks === 1)
            store.event({ ...event, key: "later", at: at + 5000 });
          setImmediate(callback); // Require the exporter to respect drain/backpressure.
        },
      }),
      at,
    );
    assert.ok(chunks > 2 && maxChunk < 70000);
    assert.equal(
      JSON.parse(text).events.length,
      1,
      "later commits cannot leak into an export already in progress",
    );
    assert.equal(
      JSON.parse(text).observations.length,
      2102,
      "equal timestamps across keyset batches are exported exactly once",
    );
    assert.equal(
      JSON.parse(text).annotations.length,
      261,
      "notes span multiple bounded batches",
    );
    assert.equal(
      store.events().length,
      2,
      "writer continues during the read snapshot",
    );
  } finally {
    reader.close();
    store.close();
  }
});
