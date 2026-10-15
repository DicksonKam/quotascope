import { test } from "node:test";
import assert from "node:assert/strict";
import { conservativePace } from "../server/metrics.ts";
import type { Observation } from "../shared/types.ts";
const now = Date.now();
const points: Observation[] = Array.from({ length: 16 }, (_, i) => ({
  account: "fixture",
  bucket: "codex",
  slot: "primary",
  at: now - (15 - i) * 60000,
  used: 10 + i / 5,
  reset: now / 1000 + 86400,
  duration: 10080,
  plan: "fixture",
  source: "account",
  resetCredits: null,
  balance: null,
}));
test("pace only appears with sufficiently dense direct evidence and never predicts exhaustion", () => {
  assert.ok(conservativePace(points, now).value);
  assert.equal(conservativePace(points, now).exhaustionHours, null);
  assert.equal(
    conservativePace(
      points.filter((_, i) => i % 5 === 0),
      now,
    ).value,
    null,
  );
  assert.equal(
    conservativePace(
      points.map((p) => ({ ...p, used: 10 })),
      now,
    ).value,
    null,
  );
  assert.equal(conservativePace(points, now + 180000).value, null);
  assert.equal(
    conservativePace(
      points.map((p, i) => ({ ...p, at: p.at - (i < 8 ? 300000 : 0) })),
      now,
    ).value,
    null,
  );
  assert.equal(
    conservativePace(
      points.map((p) => ({ ...p, source: "local" })),
      now,
    ).value,
    null,
  );
});
