import { test } from "node:test";
import assert from "node:assert/strict";
import { watchForWake } from "../server/wake.ts";

test("a wall-clock jump between heartbeats reports one wake, and normal beats or a stop report none", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let wall = 1_000_000,
    wakes = 0;
  const stop = watchForWake(() => wakes++, {
    beatMs: 10000,
    slackMs: 30000,
    now: () => wall,
  });
  for (let i = 0; i < 6; i++) {
    wall += 10000;
    t.mock.timers.tick(10000);
  }
  assert.equal(wakes, 0, "ordinary beats are not a wake");
  wall += 2 * 3600000; // The lid was closed: the wall clock moved, the timer clock did not.
  wall += 10000;
  t.mock.timers.tick(10000);
  assert.equal(wakes, 1);
  wall += 10000;
  t.mock.timers.tick(10000);
  assert.equal(wakes, 1, "only the first beat after waking reports it");
  wall += 25000; // A slow beat under the slack is not treated as sleep.
  t.mock.timers.tick(10000);
  assert.equal(wakes, 1);
  stop();
  wall += 3600000;
  t.mock.timers.tick(10000);
  assert.equal(wakes, 1, "a stopped watch reports nothing");
  t.mock.timers.reset();
});
