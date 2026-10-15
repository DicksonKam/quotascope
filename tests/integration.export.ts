import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { Store } from "../server/store.ts";
import { Collector } from "../server/collector.ts";
import { ExportJob } from "../server/export-job.ts";

const dir = mkdtempSync(join(tmpdir(), "quotascope-export-http-")),
  path = join(dir, "fixture.sqlite");
const store = new Store(path),
  count = 50000,
  now = Date.now();
store.db.exec("BEGIN");
for (let i = 0; i < count; i++) {
  const at = now - i * 60000;
  store.observe({
    account: "fixture",
    bucket: "codex",
    slot: "primary",
    source: "account",
    at,
    used: i % 100,
    reset: null,
    duration: 300,
    plan: "test",
    resetCredits: null,
    balance: null,
  });
  store.event({
    key: String(i),
    account: "fixture",
    thread: "thread",
    session: "session",
    device: "device",
    at,
    model: "test",
    effort: "medium",
    speed: "standard",
    kind: "response",
    flags: [],
    input: 100,
    cached: 0,
    cacheWrite: 0,
    output: 10,
    reasoning: 0,
    total: 110,
  });
}
store.db.exec("COMMIT");
store.close();
const exporter = new ExportJob(path),
  jobs = [exporter];
let job = exporter,
  ticks = 0,
  lastTick = performance.now(),
  maxGap = 0;
const collector = new Collector(
  async () => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - lastTick);
    lastTick = now;
    ticks++;
    return true;
  },
  true,
  () => {},
  20,
);
const server = createServer((req, res) => {
  if (req.url === "/status") {
    res.end(JSON.stringify({ ticks }));
    return;
  }
  void job.serve(res, req.url === "/csv" ? "csv" : "json");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function nextJob(entry: string, timeout = 5000) {
  const file = join(dir, `worker-${jobs.length}.mjs`);
  writeFileSync(file, entry);
  job = new ExportJob(path, timeout, pathToFileURL(file));
  jobs.push(job);
}
try {
  await collector.cycle();
  const start = performance.now(),
    startingTicks = ticks;
  let done = false,
    maxStatusMs = 0;
  const downloading = fetch(base + "/json")
    .then((r) => r.json())
    .finally(() => {
      done = true;
    });
  while (!done) {
    const probe = performance.now();
    await (await fetch(base + "/status")).text();
    maxStatusMs = Math.max(maxStatusMs, performance.now() - probe);
    await pause(20);
  }
  const data = await downloading;
  assert.equal(data.observations.length, count);
  assert.equal(data.events.length, count);
  assert.ok(
    ticks - startingTicks >= 5,
    "collector continues during actual HTTP export",
  );
  assert.ok(
    maxGap < 1000 && maxStatusMs < 1000,
    `export blocks collection/status: ${maxGap}/${maxStatusMs} ms`,
  );
  const jsonMs = performance.now() - start;
  const csv = await (await fetch(base + "/csv")).text();
  assert.equal(csv.split("\r\n").length, 2 * count + 1);
  await collector.stop();
  // Worker stays active until the client cancels; no production delay switches needed.
  await nextJob("process.stdout.write('{'); setInterval(()=>{},1000);");
  const controller = new AbortController();
  const partial = await fetch(base + "/json", { signal: controller.signal });
  assert.equal(partial.status, 200);
  const duplicate = await fetch(base + "/csv");
  assert.equal(duplicate.status, 429, "overlapping exports are bounded");
  controller.abort();
  await partial.body?.cancel().catch(() => {});
  let released = false;
  for (let i = 0; i < 50; i++) {
    await pause(20);
    const retryController = new AbortController();
    const retry = await fetch(base + "/json", {
      signal: retryController.signal,
    });
    if (retry.status === 429) {
      await retry.text();
      continue;
    }
    assert.equal(retry.status, 200, "disconnect releases the export slot");
    released = true;
    retryController.abort();
    await retry.body?.cancel().catch(() => {});
    break;
  }
  assert.ok(
    released,
    "cancelled worker must release its slot within one second",
  );
  await job.stop();
  await nextJob("process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);", 300);
  assert.equal(
    (await fetch(base + "/json")).status,
    503,
    "timed-out worker is killed, including a TERM-resistant worker",
  );
  await nextJob("process.exit(1);");
  assert.equal(
    (await fetch(base + "/json")).status,
    503,
    "failure before output returns an explicit HTTP error",
  );
  await nextJob(
    "process.stdout.write('{'); setTimeout(()=>process.exit(1),100);",
  );
  await assert.rejects(
    async () => (await fetch(base + "/json")).text(),
    "partial worker failures abort the download",
  );
  await nextJob("setInterval(()=>{},1000);");
  const pending = fetch(base + "/json");
  await pause(150);
  await job.stop();
  assert.equal(
    (await pending).status,
    503,
    "shutdown stops an in-flight export",
  );
  console.log(
    JSON.stringify({
      passed: true,
      observations: count,
      events: count,
      jsonMs,
      maxStatusMs,
      maxCollectorGapMs: maxGap,
      fixture: dir,
    }),
  );
} finally {
  await collector.stop();
  await Promise.all(jobs.map((j) => j.stop()));
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
