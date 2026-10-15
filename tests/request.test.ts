import { test } from "node:test";
import assert from "node:assert/strict";
import { performAction, DashboardRequests } from "../src/request.ts";
test("a rejected stale action token is refreshed once after service restart", async () => {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fake = (async (url: any, options?: RequestInit) => {
    calls.push({ url: String(url), options });
    return calls.length === 1
      ? new Response(JSON.stringify({ error: "Stale token" }), { status: 403 })
      : calls.length === 2
        ? new Response(JSON.stringify({ csrf: "new-token" }))
        : new Response(JSON.stringify({ version: 1 }));
  }) as typeof fetch;
  assert.deepEqual(
    await performAction("collector", { enabled: false }, "old-token", fake),
    { version: 1 },
  );
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, "/api/status");
  assert.equal(
    (calls[2].options?.headers as any)["X-QuotaScope-Token"],
    "new-token",
  );
  assert.equal(calls[0].options?.body, calls[2].options?.body);
});
test("transport errors, timeouts, and repeated rejections never replay an uncertain write", async () => {
  let calls = 0;
  const failed = (async () => {
    calls++;
    throw Error("Connection lost after request");
  }) as typeof fetch;
  await assert.rejects(
    performAction("annotations", { label: "Fixture" }, "old", failed),
  );
  assert.equal(calls, 1);
  calls = 0;
  const reject = (async (url: any) => {
    calls++;
    return new Response(
      JSON.stringify(
        String(url) === "/api/status" ? { csrf: "new" } : { error: "Rejected" },
      ),
      { status: String(url) === "/api/status" ? 200 : 403 },
    );
  }) as typeof fetch;
  await assert.rejects(
    performAction("collector", {}, "old", reject),
    /Rejected/,
  );
  assert.equal(calls, 3);
});

test("old reads cannot undo pause/resume, including reads attempted while the action runs", () => {
  const requests = new DashboardRequests();
  const old = requests.beginRead()!;
  assert.equal(requests.beginAction(), true);
  assert.equal(requests.isCurrent(old), false);
  assert.equal(requests.beginRead(), null);
  assert.equal(requests.beginAction(), false);
  requests.endAction();
  const current = requests.beginRead()!;
  assert.equal(requests.isCurrent(old), false);
  assert.equal(requests.isCurrent(current), true);
  const newer = requests.beginRead()!;
  assert.equal(requests.isCurrent(current), false);
  assert.equal(requests.isCurrent(newer), true);
});
