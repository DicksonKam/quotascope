import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Collector,
  type CollectorState,
  type CollectResult,
} from "../server/collector.ts";
import { launchAgent } from "../server/launch-agent.ts";
test("collector schedules work without dashboard requests and never overlaps cycles", async () => {
  let calls = 0,
    active = 0,
    max = 0,
    second!: () => void;
  const ready = new Promise<void>((r) => (second = r));
  const collector = new Collector(
    async () => {
      calls++;
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (calls === 2) second();
      return true;
    },
    true,
    () => {},
    10,
  );
  const first = collector.cycle();
  assert.equal(collector.cycle(), first);
  await first;
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("Background cycle did not run")), 1000),
    ),
  ]);
  await collector.stop();
  assert.equal(max, 1);
  assert.equal(calls, 2);
  assert.equal(collector.state.nextRunAt, null);
});
test("pause cancels further scheduling, persists choice and survives an in-flight read", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    saved: CollectorState[] = [];
  const collector = new Collector(
    async () => {
      await gate;
      return true;
    },
    true,
    (s) => saved.push(s),
    10,
  );
  const flight = collector.cycle();
  collector.setEnabled(false);
  release();
  await flight;
  assert.equal(collector.state.enabled, false);
  assert.equal(collector.state.nextRunAt, null);
  assert.equal(saved.at(-1)!.enabled, false);
  const restored = new Collector(
    async () => {
      throw Error("Paused collector must not run");
    },
    saved.at(-1)!.enabled,
    () => {},
    10,
  );
  await restored.cycle();
  assert.equal(restored.state.lastStartedAt, null);
  await restored.stop();
  await collector.stop();
});
test("failed collection backs off and a successful cycle restores normal cadence", async () => {
  let ok = false;
  const collector = new Collector(
    async () => ok,
    true,
    () => {},
    10000,
  );
  await collector.cycle();
  assert.equal(collector.state.failures, 1);
  assert.ok(collector.state.nextRunAt! - Date.now() > 19000);
  ok = true;
  await collector.cycle();
  assert.equal(collector.state.failures, 0);
  assert.equal(collector.state.lastError, null);
  assert.ok(collector.state.nextRunAt! - Date.now() <= 10000);
  await collector.stop();
});
test("transient failures retry at the normal interval while other failures still back off", async () => {
  let result: CollectResult = "transient";
  const c = new Collector(
    async () => result,
    true,
    () => {},
    60000,
  );
  for (let i = 0; i < 4; i++) {
    await c.cycle();
    // Still a failure for the health panel, but no growing delay after a wake or a network change.
    assert.equal(c.state.failures, i + 1);
    assert.ok(c.state.lastError);
    assert.ok(c.state.nextRunAt! - Date.now() <= 60000);
    assert.ok(c.state.nextRunAt! - Date.now() > 59000);
  }
  result = false;
  await c.cycle();
  assert.ok(c.state.nextRunAt! - Date.now() > 299000);
  result = true;
  await c.cycle();
  assert.equal(c.state.failures, 0);
  assert.ok(c.state.recoveredAt);
  assert.ok(c.state.nextRunAt! - Date.now() <= 60000);
  await c.stop();
});
test("login definition is user scoped, explicit about executables and safely escapes paths", () => {
  const xml = launchAgent(
    "/Users/test/Projects/A&B",
    "/Users/test",
    "/opt/homebrew/bin/node",
    "/Applications/Codex.app/bin/codex",
  );
  assert.ok(xml.includes("A&amp;B"));
  assert.ok(xml.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(xml.includes("<key>KeepAlive</key><true/>"));
  assert.ok(xml.includes("QUOTASCOPE_MANAGED"));
  assert.ok(!xml.includes("/Library/LaunchDaemons"));
  assert.ok(!xml.includes("turn/start"));
});

test("retry state survives restart, successful manual checks recover while pause remains respected", async () => {
  let ok = false;
  const c = new Collector(
    async () => ok,
    true,
    () => {},
    10000,
  );
  await c.cycle();
  const saved = { ...c.state };
  assert.ok(saved.failureSince);
  await c.stop();
  const restored = new Collector(
    async () => ok,
    false,
    () => {},
    10000,
    saved,
  );
  assert.equal(restored.state.failureSince, saved.failureSince);
  assert.equal(restored.state.failures, 1);
  ok = true;
  await restored.cycle(true);
  assert.equal(restored.state.failures, 0);
  assert.equal(restored.state.failureSince, null);
  assert.ok(restored.state.recoveredAt);
  assert.equal(restored.state.enabled, false);
  assert.equal(restored.state.nextRunAt, null);
  await restored.stop();
});
test("repeated failures stay within a five-minute retry cap", async () => {
  const c = new Collector(
    async () => false,
    true,
    () => {},
    60000,
  );
  for (let i = 0; i < 8; i++) await c.cycle();
  assert.ok(c.state.nextRunAt! - Date.now() <= 300000);
  assert.ok(c.state.nextRunAt! - Date.now() > 299000);
  await c.stop();
});
test("delayed execution after sleep runs once and resumes normal cadence without replaying missed cycles", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000000 });
  let calls = 0;
  const c = new Collector(
    async () => {
      calls++;
      return true;
    },
    true,
    () => {},
    60000,
  );
  await c.cycle();
  assert.equal(calls, 1);
  t.mock.timers.tick(8 * 3600000);
  await c.cycle();
  assert.equal(calls, 2);
  assert.equal(c.state.nextRunAt, Date.now() + 60000);
  await c.stop();
  t.mock.timers.reset();
});
