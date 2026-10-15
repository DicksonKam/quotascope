import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { readAccount } from "../server/account.ts";
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
    script("setInterval(()=>{},1000);");
    await assert.rejects(readAccount(300), /timed out/);
    script("process.exit(0);");
    await assert.rejects(readAccount(3000), /closed/);
    script(
      `import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2)console.log(JSON.stringify({id:2,error:{message:'PRIVATE_AUTH_DETAIL'}}));});`,
    );
    await assert.rejects(
      readAccount(3000),
      (e) =>
        e instanceof Error &&
        e.message.includes("Sign in") &&
        !e.message.includes("PRIVATE_AUTH_DETAIL"),
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
