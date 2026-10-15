import type { DashboardState } from "../shared/api.ts";
import { Collector } from "../server/collector.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  requestDashboard,
  mergeDashboardStatus,
} from "../src/dashboard-request.ts";

test("delayed analytics fall back to current status without labeling a running service unreachable", async () => {
  const urls: string[] = [];
  const result = await requestDashboard("view=activity", (async (
    url: string,
  ) => {
    urls.push(url);
    return url.startsWith("/api/state")
      ? new Response("{}", { status: 503 })
      : Response.json({
          snapshotId: "new",
          windows: [{ account: "new-account" }],
        });
  }) as typeof fetch);
  assert.equal(result.partial, true);
  assert.deepEqual(urls, ["/api/state?view=activity", "/api/status"]);
  const merged = mergeDashboardStatus(
    {
      version: 1,
      csrf: "fixture",
      now: 0,
      status: { scanning: false, refreshing: false },
      collector: {
        ...new Collector(
          async () => true,
          true,
          () => {},
        ).state,
        managed: false,
      },
      importer: new Collector(
        async () => true,
        true,
        () => {},
      ).state,
      backup: { last: null, error: null, running: false },
      operations: { scan: null, backup: null },
      attempts: [],
      scan: null,
      windows: [],
      identity: "provider",
      snapshotId: "old",
      history: [],
      coverage: {
        firstSuccessAt: 0,
        lastSuccessAt: 1,
        gapCount: 0,
        gaps: [],
        thresholdMs: 120000,
      },
    } satisfies DashboardState,
    result.data,
  );
  assert.deepEqual(merged.windowHistories, []);
  assert.equal(merged.coverage, undefined);
  assert.equal(merged.latest!.account, "new-account");
  assert.equal(merged.rate!.value, null);
  assert.equal(merged.query, undefined);
});

test("dashboard transport failure remains an error if status is also unreachable", async () => {
  await assert.rejects(
    requestDashboard("", (async () => {
      throw TypeError("Unreachable");
    }) as typeof fetch),
  );
});
