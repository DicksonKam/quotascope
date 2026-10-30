import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { readAccount, AccountReadError } from "../server/account.ts";
test("account transport times out, tolerates closed connections and recovers without changing authentication", async () => {
  const dir = mkdtempSync(`${tmpdir()}/quotascope-account-`),
    cli = join(dir, "fixture.mjs");
  const previous = process.env.QUOTASCOPE_CODEX;
  process.env.QUOTASCOPE_CODEX = cli;
  const script = (body: string) => {
    writeFileSync(cli, "#!/usr/bin/env node\n" + body);
    chmodSync(cli, 0o700);
  };
  try {
    // Network-shaped failures are transient so the collector retries next minute instead of backing off.
    const transient = (pattern: RegExp) => (e: unknown) =>
      e instanceof AccountReadError && e.transient && pattern.test(e.message);
    script("setInterval(()=>{},1000);");
    await assert.rejects(readAccount(300), transient(/timed out/));
    script("process.exit(0);");
    await assert.rejects(readAccount(3000), transient(/closed/));
    script(
      `import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,error:{message:'PRIVATE_AUTH_DETAIL'}}));});`,
    );
    await assert.rejects(
      readAccount(3000),
      (e) =>
        transient(/sign in/i)(e) &&
        !(e as Error).message.includes("PRIVATE_AUTH_DETAIL"),
    );
    // A missing CLI will not fix itself, so it keeps the longer backoff.
    await assert.rejects(
      readAccount(3000, join(dir, "missing-codex")),
      (e) => e instanceof AccountReadError && !e.transient,
    );
    script(
      `import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,result:{fixture:'recovered'}}));});`,
    );
    assert.deepEqual(await readAccount(3000), { fixture: "recovered" });
  } finally {
    if (previous === undefined) delete process.env.QUOTASCOPE_CODEX;
    else process.env.QUOTASCOPE_CODEX = previous;
  }
});
