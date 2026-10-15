import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Operation } from "../server/operation.ts";
import { ImportJob } from "../server/import-job.ts";

const dir = mkdtempSync(`${tmpdir()}/quotascope-slow-operation-`);
const entry = join(dir, "slow.mjs");
writeFileSync(entry, "setTimeout(()=>process.exit(0),31000);");
const job = new ImportJob(dir, 45000, pathToFileURL(entry));
const operation = new Operation(undefined, () => {});
const start = performance.now();
const completion = operation.run(() => job.run());
const marker = operation.state!.id;
assert.ok(performance.now() - start < 1000);
assert.equal(operation.state!.state, "running");
assert.equal(
  operation.run(() => job.run()),
  completion,
);
let responsive = 0;
const timer = setInterval(() => responsive++, 100);
try {
  assert.equal(await completion, true);
  assert.ok(performance.now() - start > 30000);
  assert.equal(operation.state!.id, marker);
  assert.equal(operation.state!.state, "succeeded");
  assert.ok(responsive > 200);
  console.log(
    JSON.stringify({
      passed: true,
      elapsedMs: Math.round(performance.now() - start),
      responsiveTicks: responsive,
      singleOperation: true,
    }),
  );
} finally {
  clearInterval(timer);
  await job.stop();
}
