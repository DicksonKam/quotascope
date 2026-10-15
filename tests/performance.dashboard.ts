import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { Store } from "../server/store.ts";
import { DashboardReader } from "../server/dashboard-reader.ts";
import { Collector } from "../server/collector.ts";
import type { Observation, TokenEvent } from "../shared/types.ts";

const root =
  process.env.QUOTASCOPE_PERFORMANCE_FIXTURES ??
  mkdtempSync(`${tmpdir()}/quotascope-performance-`);
const results: unknown[] = [];
for (const days of [90, 365]) {
  const reused = existsSync(join(root, `history-${days}.sqlite`));
  const store = new Store(join(root, `history-${days}.sqlite`));
  const now = reused
      ? store.get<{ at: number }>("accountSnapshot")!.at
      : Date.now(),
    minutes = days * 1440,
    eventCount = days === 90 ? 50000 : 200000;
  const observation: Observation = {
    account: "synthetic",
    bucket: "codex",
    slot: "primary",
    source: "account",
    identity: "provider",
    continuity: "synthetic-epoch",
    at: now,
    used: 0,
    reset: null,
    duration: 10080,
    plan: "test",
    resetCredits: null,
    balance: null,
  };
  const event: TokenEvent = {
    key: "",
    account: "synthetic",
    device: "device",
    thread: "thread",
    session: "session",
    model: "gpt-test",
    effort: "medium",
    speed: "standard",
    at: now,
    kind: "response",
    flags: [],
    input: 100,
    cached: 20,
    cacheWrite: 0,
    output: 10,
    reasoning: 0,
    total: 110,
  };
  const insertObservation = store.db.prepare(
    "INSERT INTO observations VALUES (?,?,?)",
  );
  const insertAttempt = store.db.prepare(
    "INSERT INTO attempts(data) VALUES (?)",
  );
  const insertEvent = store.db.prepare("INSERT INTO events VALUES (?,?,?)");
  const seedStart = performance.now();
  if (!reused) {
    store.db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < minutes; i++) {
      const at = now - (minutes - i) * 60000,
        ok = i % 1000 > 1;
      if (ok)
        insertObservation.run(
          String(i),
          at,
          JSON.stringify({
            ...observation,
            at,
            used: Math.floor((i % 10080) / 100.8),
            reset: Math.floor(at / 604800000) * 604800 + 604800,
          }),
        );
      insertAttempt.run(
        JSON.stringify({ at, ok, message: "Synthetic performance fixture" }),
      );
    }
    for (let i = 0; i < eventCount; i++) {
      const at =
        now - Math.floor(((eventCount - i) * days * 86400000) / eventCount);
      insertEvent.run(
        String(i),
        at,
        JSON.stringify({ ...event, key: String(i), at }),
      );
    }
    store.db.exec("COMMIT");
    store.saveAccountSnapshot({
      id: "synthetic",
      at: now,
      account: "synthetic",
      identity: "provider",
      continuity: "synthetic-epoch",
      windows: [observation],
    });
  }
  const seedMs = performance.now() - seedStart;
  console.log(
    JSON.stringify({
      phase: "seeded",
      days,
      attempts: minutes,
      events: eventCount,
      seedMs: Math.round(seedMs),
    }),
  );

  const reader = new DashboardReader(store.path, 30000);
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let checks = 0,
    lastCheck = performance.now(),
    maxCheckGapMs = 0;
  const collector = new Collector(
    async () => {
      const time = performance.now();
      maxCheckGapMs = Math.max(maxCheckGapMs, time - lastCheck);
      lastCheck = time;
      checks++;
      return true;
    },
    true,
    () => {},
    20,
  );
  await collector.cycle();
  const request = async (
    view: "overview" | "activity" | "comparisons",
    range: 7 | 90,
  ) => {
    const start = performance.now();
    const value = await reader.read({ view, days: range });
    const elapsedMs = performance.now() - start,
      bytes = Buffer.byteLength(JSON.stringify(value));
    assert.ok(value.history.length <= 600);
    assert.ok(value.coverage.gaps.length <= 20);
    assert.ok(bytes < 600000, `bounded ${view} response: ${bytes} bytes`);
    return { elapsedMs: Math.round(elapsedMs * 10) / 10, bytes };
  };
  try {
    const cold = await request("overview", 90);
    const warm = [];
    for (let i = 0; i < 12; i++) warm.push(await request("overview", 90));
    store.saveAccountSnapshot({
      id: "synthetic-next-" + now,
      at: now + 60000,
      account: "synthetic",
      identity: "provider",
      continuity: "synthetic-epoch",
      windows: [{ ...observation, at: now + 60000, used: 1 }],
    });
    const afterNewReading = await request("overview", 90);
    const sevenDays = await request("overview", 7);
    const activity = await request("activity", 90);
    const comparison = await request("comparisons", 90);
    assert.ok(checks >= 3, "collection timer continues during reads");
    assert.ok(maxCheckGapMs < 500, `collection timer gap ${maxCheckGapMs}ms`);
    results.push({
      days,
      observations: Number(
        store.db.prepare("SELECT count(*) AS n FROM observations").get()!.n,
      ),
      attempts: Number(
        store.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n,
      ),
      events: eventCount,
      cold,
      warmMaxMs: Math.max(...warm.map((r) => r.elapsedMs)),
      warmBytes: warm[0].bytes,
      afterNewReading,
      sevenDays,
      activity,
      comparison,
      collectionChecks: checks,
      maxCheckGapMs: Math.round(maxCheckGapMs * 10) / 10,
      eventLoopDelayMaxMs: Math.round(delay.max / 1e5) / 10,
      mainRssMiB: Math.round(process.memoryUsage().rss / 1048576),
      readerPeakRssMiB: Math.round(
        (reader.metrics?.peakRssBytes ?? 0) / 1048576,
      ),
    });
  } finally {
    delay.disable();
    await collector.stop();
    await reader.stop();
    store.close();
  }
}
const report = {
  runtime: process.version,
  checkedAt: new Date().toISOString(),
  results,
  fixtureDirectory: root,
};
writeFileSync(join(root, "results.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
