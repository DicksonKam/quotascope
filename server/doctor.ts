import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { configuration } from "./config.ts";
import { readAccount, accountObservations } from "./account.ts";
import { launchAgent, serviceLabel } from "./launch-agent.ts";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";

const config = configuration();
const checks: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail: string) {
  checks.push({ name, ok, detail });
}
const [major, minor] = process.versions.node.split(".").map(Number);
check(
  "runtime",
  major > 22 || (major === 22 && minor >= 13),
  `Node ${process.versions.node}; requires 22.13 or later. Use a supported Node release.`,
);
check(
  "platform",
  process.platform === "darwin",
  `${process.platform}/${process.arch}; login startup requires macOS.`,
);
let ancestor = config.dataDir;
while (!existsSync(ancestor) && dirname(ancestor) !== ancestor)
  ancestor = dirname(ancestor);
try {
  accessSync(ancestor, constants.W_OK | constants.X_OK);
  check(
    "storage",
    true,
    `Selected data directory: ${config.dataDir}${config.legacy ? " (preserved legacy installation)" : ""}`,
  );
} catch {
  check(
    "storage",
    false,
    "Choose a writable QUOTASCOPE_DATA_DIR and reinstall the service.",
  );
}
check(
  "build",
  existsSync(join(config.root, "dist/index.html")),
  "Run npm run build before starting or installing.",
);
let executable = config.codex;
if (!executable.includes("/")) {
  const found = spawnSync("/usr/bin/which", [executable], { encoding: "utf8" });
  executable = found.status === 0 ? found.stdout.trim() : executable;
}
try {
  const raw = await readAccount(5000, executable);
  accountObservations(raw, () => "doctor");
  check(
    "account capability",
    true,
    "Installed adapter returned supported allowance windows. No account data was saved.",
  );
} catch {
  check(
    "account capability",
    false,
    "Check QUOTASCOPE_CODEX, then sign in through Codex and rerun doctor.",
  );
}
try {
  const response = await fetch(`http://127.0.0.1:${config.port}/api/status`, {
    signal: AbortSignal.timeout(1500),
  });
  const status = await response.json();
  const own =
    response.ok &&
    status.version === 1 &&
    Array.isArray(status.windows) &&
    typeof status.csrf === "string";
  check(
    "port",
    own,
    own
      ? `QuotaScope responds on port ${config.port}.`
      : `Port ${config.port} belongs to an unrecognized service. Choose another PORT.`,
  );
  const latest = status.attempts?.[0];
  check(
    "recent collection",
    own && latest?.ok && Date.now() - latest.at < 180000,
    "Start or resume monitoring; check the dashboard if the latest successful read is older than three minutes.",
  );
} catch {
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port: config.port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1000, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  check(
    "port",
    !occupied,
    occupied
      ? `Port ${config.port} is occupied by an unrecognized or unresponsive service. Choose another PORT.`
      : `Port ${config.port} is available. Start QuotaScope.`,
  );
  check("recent collection", false, "Start QuotaScope, then rerun doctor.");
}
const plist = join(homedir(), "Library/LaunchAgents", serviceLabel + ".plist");
const expected = launchAgent(
  config.root,
  homedir(),
  process.execPath,
  executable,
  config,
);
check(
  "login configuration",
  existsSync(plist) && readFileSync(plist, "utf8") === expected,
  "Run npm run service -- install with the intended data directory, port and executable.",
);
console.log(JSON.stringify({ readOnly: true, checks }, null, 2));
process.exitCode = checks.every((item) => item.ok) ? 0 : 1;
