import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import {
  coverageSummary,
  monitoringHealth,
  crossesCoverageGap,
  type Coverage,
} from "../shared/monitoring.ts";
import { historyBoundary } from "../shared/history.ts";
const coverage: Coverage = {
  firstSuccessAt: 0,
  lastSuccessAt: 60000,
  thresholdMs: 120000,
  gapCount: 0,
  gaps: [],
};
test("health distinguishes fresh, delayed, paused, failed and unreachable monitoring", () => {
  assert.equal(monitoringHealth(coverage, true, false, 180000).kind, "healthy");
  assert.equal(
    monitoringHealth(coverage, true, false, 180001).label,
    "Monitoring delayed",
  );
  assert.equal(
    monitoringHealth(coverage, false, true, 180001).label,
    "Monitoring paused",
  );
  assert.match(monitoringHealth(coverage, true, true, 70000).label, /failed/);
  assert.equal(
    monitoringHealth(coverage, true, false, 70000, true).label,
    "Service unreachable",
  );
  assert.match(
    monitoringHealth({ ...coverage, lastSuccessAt: null }, true, false, 0)
      .label,
    /first/,
  );
});
test("coverage retains gaps beyond recent attempts, recovers after restart and invalidates after a read", () => {
  const path = join(
    mkdtempSync(`${tmpdir()}/quotascope-monitoring-`),
    "usage.sqlite",
  );
  let store = new Store(path);
  assert.equal(store.coverage().firstSuccessAt, null);
  for (const [at, ok] of [
    [1000, true],
    [61000, true],
    [121000, false],
    [241000, true],
  ] as const)
    store.attempt({ at, ok, message: "Synthetic read" });
  assert.deepEqual(store.coverage().gaps, [{ start: 61000, end: 241000 }]);
  for (let i = 1; i <= 30; i++)
    store.attempt({
      at: 241000 + i * 60000,
      ok: true,
      message: "Synthetic read",
    });
  assert.equal(store.attempts().length, 20);
  assert.equal(store.coverage().gapCount, 1);
  store.close();
  store = new Store(path);
  assert.deepEqual(store.coverage().gaps, [{ start: 61000, end: 241000 }]);
  const before = store.coverage().lastSuccessAt;
  assert.ok(before !== null);
  store.attempt({
    at: before + 120000,
    ok: true,
    message: "Threshold is not a gap",
  });
  assert.equal(store.coverage().gapCount, 1);
  store.attempt({
    at: before + 300001,
    ok: true,
    message: "Read after pause or outage",
  });
  assert.equal(store.coverage().gapCount, 2);
  assert.equal(store.coverage().lastSuccessAt, before + 300001);
  store.close();
});
test("downsampled account history does not infer gaps from omitted display points", () => {
  const previous = { at: 0, used: 10, reset: 1000 },
    current = { at: 86400000, used: 20, reset: 1000 };
  assert.equal(historyBoundary(previous, current, Infinity), null);
  assert.ok(historyBoundary(previous, current));
  assert.match(
    historyBoundary(previous, { ...current, used: 0 }, Infinity)!,
    /decreased/,
  );
});

test("recorded gaps break the correct chart interval despite observation and ledger timestamp jitter", () => {
  const gaps = [{ start: 1001, end: 181001 }];
  assert.equal(crossesCoverageGap(1000, 181000, gaps), true);
  assert.equal(crossesCoverageGap(181000, 241000, gaps), false);
  assert.equal(crossesCoverageGap(0, 240000, gaps), true);
  assert.equal(crossesCoverageGap(0, 1000, gaps), false);
});

test("recent coverage clips old intervals and includes an ongoing gap without claiming pre-install coverage", () => {
  const now = 2 * 86400000;
  const c = {
    ...coverage,
    firstSuccessAt: 0,
    lastSuccessAt: now - 300000,
    gapCount: 2,
    gaps: [
      { start: 0, end: 1000000 },
      { start: now - 86400000 - 60000, end: now - 86400000 + 60000 },
    ],
  };
  const summary = coverageSummary(c, now);
  assert.equal(summary.gaps, 2);
  assert.equal(summary.longestMs, 300000);
  assert.equal(summary.ongoing, true);
  assert.equal(
    coverageSummary(
      { ...coverage, firstSuccessAt: now - 60000, lastSuccessAt: now },
      now,
    ).since,
    now - 60000,
  );
});
