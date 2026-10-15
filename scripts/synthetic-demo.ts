import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../server/store.ts";
import { accountSnapshot } from "../server/account.ts";
import { identityFactory } from "../server/privacy.ts";

// This preview never invokes a real account adapter or reads the user's source logs.
const dir = mkdtempSync(join(tmpdir(), "quotascope-demo-"));
const logs = join(dir, "empty-logs");
mkdirSync(logs);
const hash = identityFactory(dir);
const store = new Store(join(dir, "quotascope.sqlite"));
const now = Date.now();
for (let minute = 120; minute >= 0; minute--) {
  const raw = {
    accountId: "synthetic-demo",
    rateLimits: {
      limitId: "codex",
      planType: "demo",
      primary: {
        usedPercent: Math.round(12 + (120 - minute) / 4),
        windowDurationMins: 300,
        resetsAt: Math.floor(now / 1000) + 7200,
      },
      secondary: {
        usedPercent: 28,
        windowDurationMins: 10080,
        resetsAt: Math.floor(now / 1000) + 3 * 86400,
      },
    },
  };
  store.saveAccountSnapshot(
    accountSnapshot(
      raw,
      hash,
      store.get("accountSnapshot"),
      now - minute * 60000,
    ),
  );
}
store.set("collectionEnabled", false);
store.close();
const child = spawn(
  process.execPath,
  ["--import", "tsx", "server/index.ts", "--production"],
  {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: process.env.PORT ?? "4328",
      QUOTASCOPE_DATA_DIR: dir,
      QUOTASCOPE_LOG_ROOT: logs,
      QUOTASCOPE_CODEX: join(dir, "no-real-provider"),
    },
    stdio: "inherit",
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
