import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ImportJob } from "../server/import-job.ts";
import { Collector } from "../server/collector.ts";
test("stalled imports neither overlap nor hold up account collection and time out", async () => {
  const dir = mkdtempSync(`${tmpdir()}/quotascope-import-`),
    entry = join(dir, "slow.mjs");
  writeFileSync(entry, "setInterval(()=>{},1000);");
  const job = new ImportJob(dir, 400, pathToFileURL(entry));
  const importFlight = job.run();
  assert.equal(job.run(), importFlight);
  let calls = 0;
  let release!: () => void;
  const twice = new Promise<void>((r) => (release = r));
  const account = new Collector(
    async () => {
      calls++;
      if (calls >= 2) release();
      return true;
    },
    true,
    () => {},
    10,
  );
  await account.cycle();
  await Promise.race([
    twice,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("Account reads blocked by import")), 1000),
    ),
  ]);
  assert.ok(calls >= 2);
  assert.equal(await importFlight, false);
  await account.stop();
  await job.stop();
});
test("a failed importer can retry successfully and shutdown stops a live import", async () => {
  const dir = mkdtempSync(`${tmpdir()}/quotascope-import-`),
    entry = join(dir, "worker.mjs");
  writeFileSync(entry, "process.exit(1);");
  const job = new ImportJob(dir, 3000, pathToFileURL(entry));
  assert.equal(await job.run(), false);
  writeFileSync(entry, "process.exit(0);");
  assert.equal(await job.run(), true);
  writeFileSync(entry, "setInterval(()=>{},1000);");
  const pending = job.run();
  await job.stop();
  assert.equal(await pending, false);
  assert.equal(await job.run(), false);
});
