import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey,
  dayCutoff,
  parseWallTime,
  validTimezone,
} from "../shared/time.ts";
import { summarize } from "../server/metrics.ts";
import type { TokenEvent } from "../shared/types.ts";

test("timezone applies to calendar grouping and date input consistently", () => {
  const at = Date.parse("2026-10-15T18:00:00Z");
  assert.equal(dayKey(at, "Asia/Hong_Kong"), "2026-10-16");
  assert.equal(dayKey(at, "America/New_York"), "2026-10-15");
  assert.equal(parseWallTime("2026-10-16T02:00", "Asia/Hong_Kong"), at);
  assert.equal(parseWallTime("2026-10-15T14:00", "America/New_York"), at);
  const event: TokenEvent = {
    key: "fixture",
    account: "fixture",
    device: "fixture",
    thread: "fixture",
    session: "fixture",
    at,
    model: "fixture",
    effort: "medium",
    speed: "unknown",
    kind: "response",
    flags: [],
    input: 10,
    cached: 0,
    cacheWrite: 0,
    output: 5,
    reasoning: 0,
    total: 15,
  };
  assert.equal(summarize([event], "Asia/Hong_Kong").days[0].name, "2026-10-16");
  assert.equal(
    summarize([event], "America/New_York").days[0].name,
    "2026-10-15",
  );
  assert.equal(
    dayCutoff(Date.parse("2026-03-09T04:30:00Z"), "America/New_York", 2),
    "2026-03-08",
  );
});

test("invalid, nonexistent and ambiguous wall times never silently move an annotation", () => {
  assert.equal(validTimezone("Invalid/Timezone"), false);
  assert.ok(
    Number.isNaN(parseWallTime("2026-03-08T02:30", "America/New_York")),
  );
  assert.ok(
    Number.isNaN(parseWallTime("2026-11-01T01:30", "America/New_York")),
  );
  assert.ok(Number.isNaN(parseWallTime("2026-02-30T12:00", "UTC")));
  assert.equal(
    parseWallTime("2026-11-01T06:30", "UTC"),
    Date.parse("2026-11-01T06:30Z"),
  );
});
