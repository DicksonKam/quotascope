import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  chmodSync,
  existsSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { launchAgent } from "../server/launch-agent.ts";
import { Store } from "../server/store.ts";
import { once } from "node:events";
import { request, createServer } from "node:http";
const dir = mkdtempSync(`${tmpdir()}/quotascope-integration-`),
  logs = join(dir, "logs"),
  dataDir = join(dir, "data"),
  config = join(dir, "state.json"),
  cli = join(dir, "codex-fixture.mjs");
mkdirSync(logs);
writeFileSync(config, JSON.stringify({ fail: false }));
writeFileSync(
  cli,
  `#!/usr/bin/env node
import {createInterface} from 'node:readline';import {readFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===1)console.log(JSON.stringify({id:1,result:{}}));if(m.id===2){const state=JSON.parse(readFileSync(process.env.QUOTASCOPE_FIXTURE_STATE,'utf8'));console.log(JSON.stringify(state.fail?{id:2,error:{code:-32000,message:'PRIVATE_ERROR_SHOULD_NOT_LEAK'}}:{id:2,result:state.result??{accountId:'fixture-private-account',rateLimits:{limitId:'codex',planType:'prolite',primary:{usedPercent:10,windowDurationMins:10080,resetsAt:Math.floor(Date.now()/1000)+86400}},rateLimitResetCredits:{availableCount:3}}}));}});
`,
);
chmodSync(cli, 0o700);
const fixture =
  [
    {
      type: "session_meta",
      payload: {
        id: "fixture-thread",
        creator_account_id: "fixture-private-account",
        base_instructions: "PRIVATE_PROMPT_SHOULD_NOT_LEAK",
      },
    },
    {
      type: "turn_context",
      payload: { model: "gpt-test", effort: "high", service_tier: "standard" },
    },
    {
      type: "token_usage_record",
      timestamp: new Date().toISOString(),
      payload: {
        response_id: "fixture-response",
        thread_id: "fixture-thread",
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 500,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: 1100,
        },
      },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n") + "\n";
const source = join(logs, "fixture.jsonl");
writeFileSync(source, fixture);
const port = 45000 + Math.floor(Math.random() * 10000),
  base = `http://127.0.0.1:${port}`;
let child: ChildProcess;
function start(logRoot = logs) {
  child = spawn(
    process.execPath,
    ["--import", "tsx", "server/index.ts", "--production"],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        PORT: String(port),
        QUOTASCOPE_DATA_DIR: dataDir,
        QUOTASCOPE_LOG_ROOT: logRoot,
        QUOTASCOPE_CODEX: cli,
        QUOTASCOPE_FIXTURE_STATE: config,
      },
      stdio: "ignore",
    },
  );
}
async function crash() {
  const done = once(child, "exit");
  child.kill("SIGKILL");
  await done;
}
async function stop() {
  const done = once(child, "exit");
  child.kill("SIGTERM");
  await done;
}
async function state() {
  return (await fetch(base + "/api/state")).json();
}
async function ready() {
  for (let i = 0; i < 100; i++) {
    try {
      const d = await state();
      if (d.attempts.length && !d.status.scanning && !d.backup.running)
        return d;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Fixture server did not become ready");
}
let assertions = 0;
const verify = (v: unknown, message: string) => {
  assert.ok(v, message);
  assertions++;
};
try {
  start();
  let d = await ready();
  verify(d.latest.used === 10, "independent account refresh");
  verify(d.usage.total === 1100, "real incremental import");
  const observed = d.latest.at;
  verify(
    d.backup.last?.verified && d.backup.last?.automatic,
    "automatic backup completes independently at startup",
  );
  verify(
    d.coverage.lastSuccessAt === observed && d.coverage.gapCount === 0,
    "coverage begins at actual successful read",
  );
  const doctorDir = join(dir, "doctor-must-not-create");
  const runDoctor = (doctorPort: number) =>
    spawnSync(process.execPath, ["--import", "tsx", "server/doctor.ts"], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        PORT: String(doctorPort),
        QUOTASCOPE_DATA_DIR: doctorDir,
        QUOTASCOPE_CONFIG: join(dir, "unused-settings.json"),
        QUOTASCOPE_CODEX: cli,
        QUOTASCOPE_FIXTURE_STATE: config,
      },
    });
  const diagnosis = runDoctor(port),
    report = JSON.parse(diagnosis.stdout);
  verify(
    report.readOnly &&
      report.checks.some((c: any) => c.name === "account capability" && c.ok),
    "doctor verifies protocol without saving account metadata",
  );
  verify(
    report.checks.some((c: any) => c.name === "port" && c.ok) &&
      report.checks.some((c: any) => c.name === "recent collection" && c.ok),
    "doctor recognizes running loopback service and fresh collection",
  );
  verify(
    !existsSync(doctorDir) && !existsSync(join(dir, "unused-settings.json")),
    "doctor creates no data directory or settings",
  );
  const unresponsive = createServer(() => {});
  unresponsive.listen(0, "127.0.0.1");
  await once(unresponsive, "listening");
  const occupiedReport = JSON.parse(
    runDoctor((unresponsive.address() as { port: number }).port).stdout,
  );
  verify(
    occupiedReport.checks.some((c: any) => c.name === "port" && !c.ok),
    "doctor detects an occupied port even when HTTP does not respond",
  );
  unresponsive.closeAllConnections();
  await new Promise<void>((resolve) => unresponsive.close(() => resolve()));
  const post = (path: string, body = {}, headers = {}) =>
    fetch(base + "/api/" + path, {
      method: "POST",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "X-QuotaScope-Token": d.csrf,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  verify(
    (await post("refresh", {}, { Origin: "https://untrusted.example" }))
      .status === 403,
    "foreign origin rejected",
  );
  verify(
    (await post("refresh", {}, { "X-QuotaScope-Token": "wrong" })).status ===
      403,
    "missing token rejected",
  );
  const hostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = request(
        base + "/api/state",
        { headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  verify(hostStatus === 403, "host rebinding rejected");
  await post("collector", { enabled: false });
  d = await state();
  verify(
    d.collector.enabled === false && d.collector.nextRunAt === null,
    "background pause is global and cancels scheduling",
  );
  verify(
    (await post("collector", { enabled: "yes" })).status === 400,
    "collector input validated",
  );
  const acceptedScan = await post("scan");
  const scanRequest = await acceptedScan.json();
  verify(
    acceptedScan.status === 202 && scanRequest.operation.id,
    "scan is acknowledged with a stable operation ID",
  );
  for (let i = 0; i < 100; i++) {
    d = await state();
    if (d.operations.scan.state !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  verify(
    d.operations.scan.id === scanRequest.operation.id &&
      d.operations.scan.state === "succeeded",
    "requested scan completion is identified",
  );
  verify(d.usage.total === 1100, "repeat import idempotence");
  verify(d.scan.bytes === 0, "unchanged scan reads zero bytes");
  verify(readFileSync(source, "utf8") === fixture, "source log unchanged");
  const json = await (await fetch(base + "/api/export?format=json")).text();
  verify(
    !/PRIVATE_PROMPT|fixture-private-account|fixture-thread|fixture-response|identity.key|\/private\//.test(
      json,
    ),
    "export contains no raw IDs, secrets or paths",
  );
  verify(JSON.parse(json).schemaVersion === 1, "versioned export");
  const csv = await (await fetch(base + "/api/export?format=csv")).text();
  verify(
    csv.includes("hongKong") && csv.includes("source"),
    "CSV provenance and timezone",
  );
  verify(
    (
      await post("annotations", {
        kind: "plan",
        account: d.latest.account,
        label: "Fixture confirmed plan",
        at: Date.now() - 10000,
        end: Date.now() + 10000,
        verified: true,
      })
    ).status === 201,
    "annotation saved",
  );
  verify(
    (
      await post("manual", {
        used: 200,
        reset: Date.now() / 1000 + 1000,
        duration: 10080,
      })
    ).status === 400,
    "invalid snapshot rejected",
  );
  writeFileSync(config, JSON.stringify({ fail: true }));
  await post("refresh");
  d = await state();
  verify(
    d.latest.at === observed,
    "failed refresh preserves successful observation time",
  );
  verify(!d.attempts[0].ok, "failed attempt recorded");
  verify(
    d.collector.failures === 1 && d.collector.failureSince,
    "failed manual read updates retry status",
  );
  verify(
    d.coverage.lastSuccessAt === observed,
    "failed reads cannot advance monitoring coverage",
  );
  verify(
    !JSON.stringify(d).includes("PRIVATE_ERROR"),
    "raw provider errors excluded",
  );
  const backupResponse = await post("backup");
  const backup = await backupResponse.json();
  verify(
    backupResponse.status === 202 && backup.operation.state === "running",
    "backup acknowledged before completion",
  );
  for (let i = 0; i < 100; i++) {
    d = await state();
    if (d.operations.backup.state !== "running") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  verify(
    d.operations.backup.id === backup.operation.id &&
      d.operations.backup.state === "succeeded",
    "new backup completion is distinct from old successful copies",
  );
  const folders = readdirSync(join(dataDir, "backups"));
  verify(
    folders.length === 2,
    "automatic startup snapshot and manual snapshot retained",
  );
  const restored = join(dir, "restored");
  const restore = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "server/restore.ts",
      join(dataDir, "backups", folders.find((n) => n.startsWith("backup-"))!),
      restored,
    ],
    { cwd: resolve("."), encoding: "utf8" },
  );
  verify(restore.status === 0, "restore CLI succeeds into new target");
  const recovered = new Store(join(restored, "quotascope.sqlite"));
  verify(
    recovered.events().length === 1 && recovered.annotations().length === 1,
    "restored usage and annotations match",
  );
  recovered.close();
  if (process.platform === "darwin") {
    const plistPath = join(dir, "restored service.plist");
    writeFileSync(
      plistPath,
      launchAgent(resolve("."), homedir(), process.execPath, cli, {
        dataDir: restored,
        port,
        settingsPath: join(dir, "restored-settings.json"),
        logRoot: logs,
      }),
    );
    const parsed = spawnSync(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", plistPath],
      { encoding: "utf8" },
    );
    verify(
      parsed.status === 0,
      "generated restored-service plist is accepted by macOS",
    );
    const definition = JSON.parse(parsed.stdout);
    await stop();
    child = spawn(
      definition.ProgramArguments[0],
      definition.ProgramArguments.slice(1),
      {
        cwd: definition.WorkingDirectory,
        env: {
          ...process.env,
          ...definition.EnvironmentVariables,
          QUOTASCOPE_FIXTURE_STATE: config,
        },
        stdio: "ignore",
      },
    );
    const serviceState = await ready();
    verify(
      serviceState.collector.managed &&
        serviceState.usage.total === 1100 &&
        serviceState.annotations.length === 1,
      "actual generated service command runs the restored data with preserved identity and notes",
    );
    await stop();
    start();
    d = await ready();
  }

  const repeat = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "server/restore.ts",
      join(dataDir, "backups", folders.find((n) => n.startsWith("backup-"))!),
      restored,
    ],
    { cwd: resolve("."), encoding: "utf8" },
  );
  verify(repeat.status !== 0, "restore refuses overwrite");
  await stop();
  writeFileSync(config, JSON.stringify({ fail: false }));
  start();
  d = await ready();
  verify(
    d.history.some((o: any) => o.at === observed),
    "restart preserves original timestamp",
  );
  verify(d.usage.total === 1100, "restart preserves deduplicated usage");
  verify(d.annotations.length === 1, "restart preserves notes");
  verify(
    d.collector.enabled === false,
    "restart preserves paused background setting",
  );
  await post("collector", { enabled: true });
  for (let i = 0; i < 30; i++) {
    d = await state();
    if (d.collector.lastCompletedAt) break;
    await new Promise((r) => setTimeout(r, 30));
  }
  verify(
    d.collector.enabled && d.collector.lastCompletedAt && d.attempts[0].ok,
    "resuming restarts independent background collection",
  );
  verify(
    d.collector.recoveredAt && d.collector.failures === 0,
    "recovery is recorded after restart",
  );
  await stop();
  const invalidRoot = join(dir, "not-a-folder");
  writeFileSync(invalidRoot, "Synthetic unreadable import root");
  start(invalidRoot);
  d = await ready();
  verify(
    d.importer.failures > 0 && d.importer.lastError,
    "failed local import is exposed separately",
  );
  const successfulBefore = d.coverage.lastSuccessAt;
  await post("refresh");
  d = await state();
  verify(
    d.attempts[0].ok && d.coverage.lastSuccessAt >= successfulBefore,
    "account reads continue despite importer failure",
  );
  verify(
    d.collector.failures === 0 && d.importer.failures > 0,
    "account and import retry state remain independent",
  );
  await stop();
  start();
  d = await ready();
  verify(
    d.importer.recoveredAt && d.importer.failures === 0,
    "local import retries recover independently after restart",
  );

  const beforeCrash = d.latest.at,
    oldToken = d.csrf,
    backupCount = readdirSync(join(dataDir, "backups")).length;
  await crash();
  start();
  d = await ready();
  verify(
    d.history.some((o: any) => o.at === beforeCrash) &&
      d.annotations.length === 1 &&
      d.usage.total === 1100,
    "unexpected process exit preserves committed history and notes",
  );
  verify(
    d.attempts[0].ok && d.collector.enabled,
    "restart resumes account collection after unexpected exit",
  );
  verify(
    readdirSync(join(dataDir, "backups")).length === backupCount,
    "restart does not duplicate a recent verified daily backup",
  );
  verify(
    d.csrf !== oldToken &&
      (await post("refresh", {}, { "X-QuotaScope-Token": oldToken })).status ===
        403,
    "restart rotates stale action token before executing writes",
  );

  // Exercise current membership and identity transitions over real HTTP/RPC/storage.
  await post("collector", { enabled: false });
  d = await state();
  const primary = {
    usedPercent: 99,
    windowDurationMins: 300,
    resetsAt: Math.floor(Date.now() / 1000) + 3600,
  };
  const secondary = {
    usedPercent: 10,
    windowDurationMins: 10080,
    resetsAt: Math.floor(Date.now() / 1000) + 86400,
  };
  const multi = {
    accountId: "fixture-private-account",
    rateLimitsByLimitId: {
      other: { primary: { ...primary, usedPercent: 20 } },
      codex: { primary, secondary },
    },
  };
  writeFileSync(config, JSON.stringify({ result: multi }));
  await post("refresh");
  d = await state();
  verify(
    d.windows.length === 3 &&
      d.latest.bucket === "codex" &&
      d.latest.used === 99,
    "all windows visible; dominant read does not depend on bucket insertion order",
  );
  verify(
    d.windowHistories.length === 1 &&
      d.windows.every((w: any) => w.at === d.latest.at),
    "current windows stay coherent while only selected history is loaded",
  );
  const selectedKey = JSON.stringify(["codex", "secondary"]);
  const selected = await (
    await fetch(
      base +
        "/api/state?" +
        new URLSearchParams({ days: "7", window: selectedKey }),
    )
  ).json();
  verify(
    selected.windows.length === 3 &&
      selected.latest.slot === "secondary" &&
      selected.history.every((o: any) => o.slot === "secondary"),
    "explicit range/window query keeps all balances and isolates selected history",
  );
  verify(
    selected.query.days === 7 &&
      selected.query.window === selectedKey &&
      selected.comparison === null,
    "overview does not compute comparison details",
  );
  const activity = await (
    await fetch(base + "/api/state?view=activity")
  ).json();
  verify(
    activity.usage.days.length <= 90 &&
      activity.usage.byModel.length <= 50 &&
      activity.usage.total === 1100,
    "bounded activity details preserve all-time totals",
  );
  const cycleActivity = await (
    await fetch(
      base +
        "/api/state?view=activity&activityScope=current&historyScope=current",
    )
  ).json();
  verify(
    cycleActivity.query.activityScope === "current" &&
      cycleActivity.query.historyScope === "current" &&
      typeof cycleActivity.activityScope.available === "boolean",
    "cycle scopes pass through HTTP and the read worker",
  );
  verify(
    (await fetch(base + "/api/state?activityScope=bad")).status === 400 &&
      (await fetch(base + "/api/state?historyScope=bad")).status === 400,
    "invalid activity and history scopes rejected",
  );
  const comparisonView = await (
    await fetch(base + "/api/state?view=comparisons")
  ).json();
  verify(
    comparisonView.comparison.status === "Insufficient evidence" &&
      comparisonView.accounts.includes(d.latest.account),
    "comparisons load only on request with known account choices",
  );
  verify(
    (await fetch(base + "/api/state?days=365")).status === 400,
    "unsupported history range rejected",
  );
  const quick = await (await fetch(base + "/api/status")).json();
  verify(
    quick.windows.length === 3 &&
      quick.history === undefined &&
      quick.usage === undefined &&
      quick.attempts[0].ok,
    "independent lightweight status avoids history and analytics",
  );
  const continuity = d.latest.continuity,
    keys = d.windows.map((w: any) => w.bucket + ":" + w.slot);
  writeFileSync(
    config,
    JSON.stringify({
      result: {
        ...multi,
        rateLimitsByLimitId: {
          codex: { primary, secondary },
          other: multi.rateLimitsByLimitId.other,
        },
      },
    }),
  );
  await post("refresh");
  d = await state();
  verify(
    JSON.stringify(d.windows.map((w: any) => w.bucket + ":" + w.slot)) ===
      JSON.stringify(keys) && d.latest.continuity === continuity,
    "response reordering preserves selection and continuity",
  );
  const single = {
    accountId: "fixture-private-account",
    rateLimits: { limitId: "codex", primary },
  };
  writeFileSync(config, JSON.stringify({ result: single }));
  await post("refresh");
  d = await state();
  verify(
    d.windows.length === 1 &&
      d.windowHistories.length === 1 &&
      d.latest.continuity !== continuity,
    "removed windows disappear without becoming stale current members",
  );
  const afterRemoval = d.latest.continuity,
    accountA = d.latest.account;
  writeFileSync(
    config,
    JSON.stringify({
      result: { ...single, accountId: "second-private-account" },
    }),
  );
  await post("refresh");
  d = await state();
  verify(
    d.latest.account !== accountA &&
      d.history.length === 1 &&
      d.localHistory.length === 0 &&
      d.rate.value === null,
    "account switch cannot inherit another account trend or local logs",
  );
  writeFileSync(config, JSON.stringify({ result: single }));
  await post("refresh");
  d = await state();
  verify(
    d.latest.account === accountA &&
      d.latest.continuity !== afterRemoval &&
      d.rate.value === null,
    "returning account gets a new continuity segment",
  );
  const beforeFailure = d.latest.continuity;
  writeFileSync(config, JSON.stringify({ fail: true }));
  await post("refresh");
  d = await state();
  verify(
    d.latest.continuity === beforeFailure && !d.attempts[0].ok,
    "failed read preserves last complete snapshot with failed health",
  );
  writeFileSync(config, JSON.stringify({ result: single }));
  await post("refresh");
  d = await state();
  verify(
    d.latest.continuity !== beforeFailure,
    "reconnection does not claim uninterrupted account continuity",
  );
  writeFileSync(
    config,
    JSON.stringify({ result: { rateLimits: single.rateLimits } }),
  );
  await post("refresh");
  d = await state();
  const firstUnknown = d.latest.account;
  verify(
    d.identity === "unknown" &&
      d.history.length === 1 &&
      d.localHistory.length === 0 &&
      d.rate.value === null,
    "documented no-ID response remains useful without inferred attribution",
  );
  await post("refresh");
  d = await state();
  verify(
    d.latest.account !== firstUnknown &&
      d.history.length === 1 &&
      d.accounts.every((a: string) => !a.startsWith("unattributed")),
    "successive unidentified reads cannot share an account history or create selectable identities",
  );
  writeFileSync(config, JSON.stringify({ result: single }));
  await post("refresh");
  d = await state();
  verify(
    d.identity === "provider" &&
      d.latest.account === accountA &&
      d.rate.value === null,
    "known identity resumes without borrowing unknown observations",
  );
  const exported = await (await fetch(base + "/api/export?format=json")).text();
  verify(
    !/fixture-private-account|second-private-account/.test(exported) &&
      JSON.parse(exported).observations.some((o: any) => o.bucket === "other"),
    "exports preserve removed windows and exclude raw identity",
  );
  const beforeManual = d.latest.at;
  verify(
    (
      await post("manual", {
        used: 1,
        reset: Date.now() / 1000 + 3600,
        duration: 300,
      })
    ).status === 201,
    "manual history entry remains supported",
  );
  d = await state();
  verify(
    d.latest.at === beforeManual && d.latest.used === 99,
    "manual entry cannot replace current reported windows",
  );
  const beforeRestart = JSON.stringify(d.windows);
  await stop();
  start();
  d = await ready();
  verify(
    JSON.stringify(d.windows) === beforeRestart,
    "paused restart retains exact current window membership and timestamps",
  );
  // A restart must preserve the last requested outcome even while automatic jobs run.
  await stop();
  const interrupted = new Store(join(dataDir, "quotascope.sqlite"));
  for (const kind of ["scan", "backup"])
    interrupted.set(kind + "Operation", {
      id: "interrupted-" + kind,
      state: "running",
      startedAt: Date.now() - 1000,
      completedAt: null,
    });
  interrupted.set("collectionEnabled", true);
  interrupted.close();
  start();
  d = await ready();
  verify(
    d.operations.scan.id === "interrupted-scan" &&
      d.operations.scan.state === "interrupted",
    "automatic import cannot overwrite an interrupted requested scan",
  );
  verify(
    d.operations.backup.id === "interrupted-backup" &&
      d.operations.backup.state === "interrupted",
    "startup automatic backup cannot overwrite an interrupted requested backup",
  );
  await post("collector", { enabled: false });
  await stop();
  start(invalidRoot);
  d = await ready();
  const failedRequest = await (await post("scan")).json();
  for (let i = 0; i < 100; i++) {
    d = await state();
    if (d.operations.scan.state !== "running") break;
    await new Promise((r) => setTimeout(r, 30));
  }
  verify(
    d.operations.scan.id === failedRequest.operation.id &&
      d.operations.scan.state === "failed",
    "accepted failing scan reports its own durable failure",
  );
  await stop();
  const enabledStore = new Store(join(dataDir, "quotascope.sqlite"));
  enabledStore.set("collectionEnabled", true);
  enabledStore.close();
  start();
  d = await ready();
  verify(
    !d.importer.lastError &&
      d.operations.scan.id === failedRequest.operation.id &&
      d.operations.scan.state === "failed",
    "successful automatic retry preserves last requested failure for a reopened dashboard",
  );
  // A filesystem failure in the real backup worker must also survive the next automatic check.
  renameSync(join(dataDir, "backups"), join(dataDir, "preserved-backups"));
  writeFileSync(
    join(dataDir, "backups"),
    "Fixture blocker, preserved after test",
  );
  const failedBackup = await (await post("backup")).json();
  for (let i = 0; i < 100; i++) {
    d = await state();
    if (d.operations.backup.state !== "running") break;
    await new Promise((r) => setTimeout(r, 30));
  }
  verify(
    d.operations.backup.id === failedBackup.operation.id &&
      d.operations.backup.state === "failed",
    "accepted backup failure keeps its requested ID",
  );
  await stop();
  renameSync(
    join(dataDir, "backups"),
    join(dataDir, "preserved-backup-blocker.txt"),
  );
  renameSync(join(dataDir, "preserved-backups"), join(dataDir, "backups"));
  start();
  d = await ready();
  verify(
    !d.backup.error &&
      d.operations.backup.id === failedBackup.operation.id &&
      d.operations.backup.state === "failed",
    "automatic backup recovery cannot relabel a failed manual request as successful",
  );
  console.log(
    JSON.stringify({
      assertionsPassed: assertions,
      result: "passed",
      checks: [
        "live protocol fixture",
        "privacy export",
        "origin and CSRF",
        "incremental idempotence",
        "failure preservation",
        "backup",
        "restart persistence",
      ],
      artifacts: dir,
    }),
  );
} finally {
  if (child! && child.exitCode === null) await stop();
}
