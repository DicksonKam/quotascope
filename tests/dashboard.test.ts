import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../server/store.ts";
import { DashboardData } from "../server/dashboard-data.ts";
import { DashboardReader } from "../server/dashboard-reader.ts";
import { queryHistory, historyLimit } from "../server/history-query.ts";
import { accountSnapshot } from "../server/account.ts";
import { historyBoundary } from "../shared/history.ts";
import { coverageSummary } from "../shared/monitoring.ts";
import type { Observation, TokenEvent } from "../shared/types.ts";

const now = Date.now();
const observation = (
  at: number,
  used = 10,
  extra: Partial<Observation> = {},
): Observation => ({
  account: "account",
  bucket: "codex",
  slot: "primary",
  source: "account",
  at,
  used,
  reset: 2000000000,
  duration: 10080,
  plan: "test",
  resetCredits: null,
  balance: null,
  continuity: "epoch",
  identity: "provider",
  ...extra,
});
const event = (key: string, at = now): TokenEvent => ({
  key,
  at,
  account: "account",
  device: "device",
  thread: "thread",
  session: "session",
  model: "gpt-test",
  effort: "medium",
  speed: "standard",
  kind: "response",
  flags: [],
  input: 100,
  cached: 20,
  cacheWrite: 0,
  output: 10,
  reasoning: 0,
  total: 110,
});
function fixture() {
  return new Store(
    join(mkdtempSync(`${tmpdir()}/quotascope-dashboard-`), "usage.sqlite"),
  );
}
function current(store: Store) {
  const snapshot = accountSnapshot(
    {
      accountId: "raw",
      rateLimits: {
        limitId: "codex",
        primary: {
          usedPercent: 20,
          windowDurationMins: 10080,
          resetsAt: 2000000000,
        },
      },
    },
    () => "account",
    undefined,
    now,
  );
  store.saveAccountSnapshot(snapshot);
  return snapshot;
}

test("range queries preserve reset, continuity, gaps and extreme values before sampling", () => {
  const store = fixture(),
    start = now - 6 * 86400000;
  try {
    store.db.exec("BEGIN");
    for (let i = 0; i < 12000; i++) {
      const at = start + i * 30000;
      if (i === 6000 || i === 6001 || i === 6002 || i === 6003) continue;
      store.observe(
        observation(at, i === 2345 ? 97 : i >= 3456 ? 2 : 10, {
          reset: i >= 3456 ? 2000600000 : 2000000000,
          continuity: i >= 7890 ? "new-epoch" : "epoch",
        }),
      );
    }
    store.observe(observation(now - 100 * 86400000, 88));
    store.observe(observation(now - 1000, 99, { account: "other-account" }));
    store.db.exec("COMMIT");
    const result = queryHistory(
      store,
      observation(now),
      "account",
      now - 7 * 86400000,
      now,
    );
    assert.ok(result.points.length <= historyLimit);
    assert.equal(result.truncated, false);
    assert.ok(
      result.points.every(
        (p) => p.at >= now - 7 * 86400000 && p.account === "account",
      ),
    );
    for (const i of [2345, 3455, 3456, 5999, 6004, 7889, 7890])
      assert.ok(
        result.points.some((p) => p.at === start + i * 30000),
        `boundary/extreme ${i} retained`,
      );
    assert.ok(
      result.points.some(
        (p, i) => i > 0 && historyBoundary(result.points[i - 1], p, Infinity),
      ),
    );
    const before = result.points.map((p) => [p.at, p.used, p.chartSegment]);
    store.observe(observation(now - 200 * 86400000, 1));
    assert.deepEqual(
      queryHistory(
        store,
        observation(now),
        "account",
        now - 7 * 86400000,
        now,
      ).points.map((p) => [p.at, p.used, p.chartSegment]),
      before,
    );
  } finally {
    store.close();
  }
});

test("pathological boundary counts produce a bounded, explicitly clipped history with no invented continuity", () => {
  const store = fixture();
  try {
    store.db.exec("BEGIN");
    for (let i = 0; i < 3000; i++)
      store.observe(observation(now - (3000 - i) * 60000, i % 2 ? 99 : 1));
    store.db.exec("COMMIT");
    const result = queryHistory(
      store,
      observation(now),
      "account",
      now - 7 * 86400000,
      now,
    );
    assert.equal(result.points.length, historyLimit);
    assert.equal(result.truncated, true);
    assert.equal(result.points.at(-1)!.at, now - 60000);
    assert.ok(
      result.points.every(
        (p, i) =>
          i === 0 ||
          p.chartSegment !== result.points[i - 1].chartSegment ||
          p.used >= result.points[i - 1].used,
      ),
    );
  } finally {
    store.close();
  }
});

test("summary cache follows external committed writes and ignores rolled-back changes", () => {
  const store = fixture();
  current(store);
  store.event(event("first"));
  const reader = new Store(store.path, true),
    data = new DashboardData(reader);
  let reads = 0;
  const original = reader.events.bind(reader);
  reader.events = () => {
    reads++;
    return original();
  };
  try {
    assert.equal(data.read({}, now).usage.total, 110);
    assert.equal(data.read({}, now).usage.total, 110);
    assert.equal(reads, 1);
    store.db.exec("BEGIN");
    store.event(event("rolled-back"));
    store.db.exec("ROLLBACK");
    assert.equal(data.read({}, now).usage.total, 110);
    assert.equal(reads, 1);
    store.event(event("second"));
    assert.equal(data.read({}, now).usage.total, 220);
    assert.equal(reads, 2);
    store.event({ ...event("first"), input: 200, total: 210 });
    assert.equal(
      data.read({}, now).usage.total,
      110,
      "conflicting response is excluded after cache invalidation",
    );
    assert.equal(reads, 3);
    assert.equal(
      data.read({ view: "activity" }, now + 3600001).usage
        .recentTokensPerMinute,
      0,
      "recent pace expires without requiring a new import",
    );
    assert.equal(data.read({}, now).comparison, null);
    const observations = reader.observations.bind(reader);
    reader.observations = () => {
      throw Error("Ineligible comparisons must not read the ledger");
    };
    assert.equal(
      data.read({ view: "comparisons" }, now).comparison!.status,
      "Insufficient evidence",
    );
    reader.observations = observations;
    assert.equal(reads, 3);
  } finally {
    reader.close();
    store.close();
  }
});

test("bounded coverage retains complete counts and recent statistics beyond its 20 displayed gaps", () => {
  const store = fixture();
  try {
    for (let i = 0; i < 50; i++)
      store.attempt({ at: now - (50 - i) * 180000, ok: true, message: "test" });
    const result = new DashboardData(store).read({}, now);
    assert.equal(result.coverage.gapCount, 49);
    assert.equal(result.coverage.gaps.length, 20);
    assert.equal(
      coverageSummary(result.coverage, now).gaps,
      50,
      "49 completed gaps plus ongoing interval",
    );
  } finally {
    store.close();
  }
});

test("activity calendar range expires cached days while retaining all-time totals", () => {
  const store = fixture();
  try {
    store.event(event("old", now - 200 * 86400000));
    store.event(event("recent", now));
    const data = new DashboardData(store);
    const first = data.read({ view: "activity" }, now);
    assert.equal(first.usage.total, 220);
    assert.equal(first.usage.days.length, 1);
    const later = data.read({ view: "activity" }, now + 91 * 86400000);
    assert.equal(later.usage.days.length, 0);
    assert.equal(later.usage.total, 220);
  } finally {
    store.close();
  }
});

test("the reader process serves isolated current identity and can stop while a read is pending", async () => {
  const store = fixture(),
    known = current(store);
  store.event(event("first"));
  const reader = new DashboardReader(store.path);
  try {
    const first = await reader.read();
    assert.equal(first.latest!.account, known.account);
    assert.equal(first.usage.total, 110);
    const unknown = accountSnapshot(
      { rateLimits: { primary: { usedPercent: 1 } } },
      () => "unused",
    );
    store.saveAccountSnapshot(unknown);
    const next = await reader.read();
    assert.equal(next.identity, "unknown");
    assert.equal(next.history.length, 1);
    assert.equal(next.localHistory.length, 0);
    const pending = reader.read({ view: "comparisons" });
    const rejected = assert.rejects(pending, /unavailable/);
    await reader.stop();
    await rejected;
  } finally {
    await reader.stop();
    store.close();
  }
});

test("an idle reader releases its process and opens again without changing stored data", async () => {
  const store = fixture();
  current(store);
  store.event(event("first"));
  const reader = new DashboardReader(store.path, 15000, 20);
  try {
    assert.equal((await reader.read()).usage.total, 110);
    const firstPid = reader.metrics!.pid;
    await new Promise((resolve) => setTimeout(resolve, 60));
    store.event(event("second"));
    assert.equal((await reader.read()).usage.total, 220);
    assert.notEqual(reader.metrics!.pid, firstPid);
    assert.equal(store.events().length, 2);
  } finally {
    await reader.stop();
    store.close();
  }
});

test("an unexpected reader exit is recoverable without losing committed history", async () => {
  const store = fixture();
  current(store);
  store.event(event("first"));
  const reader = new DashboardReader(store.path);
  try {
    await reader.read();
    const pid = reader.metrics!.pid;
    process.kill(pid, "SIGKILL");
    let recovered: any;
    for (let i = 0; i < 10 && !recovered; i++) {
      try {
        recovered = await reader.read();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    assert.equal(recovered?.usage.total, 110);
    assert.equal(recovered?.history.length, 1);
    assert.notEqual(reader.metrics!.pid, pid);
  } finally {
    await reader.stop();
    store.close();
  }
});
