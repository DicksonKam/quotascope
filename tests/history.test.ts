import { test } from "node:test";
import assert from "node:assert/strict";
import { historyBoundary, remainingPercent } from "../shared/history.ts";
const observation = (
  at: number,
  used: number,
  reset: number | null = 2000000000,
) => ({ at, used, reset });
test("remaining allowance is the bounded inverse of used percentage", () => {
  assert.equal(remainingPercent(4), 96);
  assert.equal(remainingPercent(100), 0);
  assert.equal(remainingPercent(0), 100);
  assert.equal(remainingPercent(110), 0);
});
test("ordinary consumption stays connected as remaining allowance decreases", () => {
  const a = observation(0, 4),
    b = observation(60000, 5);
  assert.ok(remainingPercent(b.used) < remainingPercent(a.used));
  assert.equal(historyBoundary(a, b), null);
});
test("window changes and counter adjustments remain uncertain connectors, not usage strokes", () => {
  assert.match(
    historyBoundary(observation(0, 70), observation(60000, 1, 2000600000))!,
    /window changed/,
  );
  assert.match(
    historyBoundary(observation(0, 5), observation(60000, 4))!,
    /reporting adjustment/,
  );
  assert.equal(
    historyBoundary(observation(0, 5), observation(60000, 6, 2000000005)),
    null,
  );
});
test("historical observation gaps stay identifiable without fabricating intervening readings", () => {
  assert.equal(
    historyBoundary(observation(0, 5), observation(7 * 3600000, 10)),
    "No observations between these points",
  );
});
