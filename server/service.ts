import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
  chmodSync,
  openSync,
  closeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { launchAgent, serviceLabel } from "./launch-agent.ts";
import { trashAgent, waitForServiceStop } from "./service-files.ts";
import { configuration } from "./config.ts";
import { dirname, isAbsolute } from "node:path";
if (process.platform !== "darwin")
  throw new Error("Login services are supported on macOS.");
const root = resolve(import.meta.dirname, ".."),
  home = homedir(),
  domain = `gui/${process.getuid!()}`,
  target = `${domain}/${serviceLabel}`;
const config = configuration(root);
const folder = join(config.dataDir, "service"),
  plist = join(home, "Library/LaunchAgents", serviceLabel + ".plist"),
  staged = join(folder, serviceLabel + ".plist");
const run = (args: string[], check = true) => {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (check && result.status !== 0)
    throw new Error(`launchctl ${args[0]} failed: ${result.stderr.trim()}`);
  return result;
};
const which = (name: string) => {
  const r = spawnSync("/usr/bin/which", [name], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`Cannot locate ${name}.`);
  return r.stdout.trim();
};
const installed = () => existsSync(plist);
function prepare() {
  if (!existsSync(join(root, "dist/index.html")))
    throw new Error("Run npm run build before installing the service.");
  const node = process.execPath,
    codex = isAbsolute(config.codex) ? config.codex : which(config.codex);
  if (!existsSync(node) || !existsSync(codex))
    throw new Error("Node or Codex executable is unavailable.");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  for (const name of ["stdout.log", "stderr.log"]) {
    const file = join(folder, name);
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
  }
  const xml = launchAgent(root, home, node, codex, config);
  writeFileSync(staged, xml, { mode: 0o600 });
  const lint = spawnSync("/usr/bin/plutil", ["-lint", staged], {
    encoding: "utf8",
  });
  if (lint.status !== 0)
    throw new Error("Generated login agent failed plist validation.");
  return xml;
}
function start() {
  if (!installed()) throw new Error("Install the login service first.");
  run(["enable", target]);
  if (run(["print", target], false).status !== 0)
    run(["bootstrap", domain, plist]);
}
const command = process.argv[2] ?? "status";
if (command === "prepare") {
  prepare();
  console.log(`Validated login service at ${staged}`);
} else if (command === "install") {
  const xml = prepare();
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  if (installed()) {
    const old = readFileSync(plist, "utf8");
    if (
      !old.includes("<key>QUOTASCOPE_DATA_DIR</key>") ||
      !old.includes("server/index.ts")
    )
      throw new Error(
        "The installed agent is not recognized as QuotaScope. Preserve it and resolve the label conflict.",
      );
    if (old !== xml)
      copyFileSync(plist, join(folder, `previous-agent-${Date.now()}.plist`));
    run(["bootout", target], false);
    await waitForServiceStop(() => run(["print", target], false).status === 0);
  }
  mkdirSync(dirname(config.settingsPath), { recursive: true, mode: 0o700 });
  if (existsSync(config.settingsPath))
    copyFileSync(
      config.settingsPath,
      join(folder, `previous-settings-${Date.now()}.json`),
    );
  writeFileSync(
    config.settingsPath,
    JSON.stringify(
      {
        dataDir: config.dataDir,
        port: config.port,
        logRoot: config.logRoot,
        codex: isAbsolute(config.codex) ? config.codex : which(config.codex),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  chmodSync(config.settingsPath, 0o600);
  writeFileSync(plist, xml, { mode: 0o600 });
  chmodSync(plist, 0o600);
  start();
  console.log(`Installed and started ${serviceLabel}. It will start at login.`);
} else if (command === "start" || command === "enable") {
  start();
  console.log("Login service enabled and running.");
} else if (command === "stop" || command === "disable") {
  if (command === "disable") run(["disable", target]);
  run(["bootout", target], false);
  await waitForServiceStop(() => run(["print", target], false).status === 0);
  console.log(
    command === "disable"
      ? "Stopped and disabled automatic login start."
      : "Stopped. It remains configured to start at next login.",
  );
} else if (command === "uninstall") {
  const trash = join(home, ".Trash");
  if (!existsSync(trash))
    throw new Error(
      "Trash unavailable; uninstall stopped without removing the agent.",
    );
  run(["bootout", target], false);
  await waitForServiceStop(() => run(["print", target], false).status === 0);
  if (run(["print", target], false).status === 0)
    throw new Error("The service is still running; no file was moved.");
  const destination = trashAgent(plist, trash);
  console.log(
    destination
      ? `Service removed recoverably: ${destination}`
      : "No login agent file is installed.",
  );
} else if (command === "status") {
  const result = run(["print", target], false);
  const disabled = run(["print-disabled", domain], false)
    .stdout.split("\n")
    .some((line) => line.includes(serviceLabel) && line.includes("=> true"));
  console.log(
    JSON.stringify(
      {
        label: serviceLabel,
        installed: installed(),
        loginEnabled: installed() && !disabled,
        loaded: result.status === 0,
        state: result.stdout.match(/^\s*state = (.+)$/m)?.[1] ?? "not loaded",
        pid: Number(result.stdout.match(/^\s*pid = (\d+)$/m)?.[1]) || null,
      },
      null,
      2,
    ),
  );
} else
  throw new Error(
    "Usage: npm run service -- prepare|install|status|start|stop|enable|disable|uninstall",
  );
