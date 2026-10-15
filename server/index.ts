import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { Store } from "./store.ts";
import { identityFactory, numeric, label } from "./privacy.ts";
import { readAccount, accountSnapshot } from "./account.ts";
import { DashboardReader, type DashboardQuery } from "./dashboard-reader.ts";
import { ImportJob } from "./import-job.ts";
import { ExportJob } from "./export-job.ts";
import type {
  AccountSnapshot,
  Annotation,
  Observation,
} from "../shared/types.ts";
import { Collector } from "./collector.ts";
import { Operation, type OperationState } from "./operation.ts";
import { validTimezone } from "../shared/time.ts";
import type { DashboardStatus } from "../shared/api.ts";
import { configuration } from "./config.ts";

const config = configuration();
const { port, root, dataDir: dir } = config;
mkdirSync(dir, { recursive: true, mode: 0o700 });
const hash = identityFactory(dir),
  store = new Store(join(dir, "quotascope.sqlite"));
chmodSync(store.path, 0o600);
const csrf = randomBytes(32).toString("hex");
let refreshing: Promise<boolean> | null = null;
let status = { scanning: false, refreshing: false };
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    status.refreshing = true;
    try {
      const raw = await readAccount(20000, config.codex);
      const previous = store.get<boolean>("accountContinuityBroken")
        ? undefined
        : store.get<AccountSnapshot>("accountSnapshot");
      store.saveAccountSnapshot(accountSnapshot(raw, hash, previous));
      return true;
    } catch (e) {
      store.accountReadFailed((e as Error).message);
      return false;
    } finally {
      status.refreshing = false;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
const scanOperation = new Operation(
  store.get<OperationState>("scanOperation"),
  (state) => store.set("scanOperation", state),
);
const backupOperation = new Operation(
  store.get<OperationState>("backupOperation"),
  (state) => store.set("backupOperation", state),
);
const importJob = new ImportJob(
  dir,
  120000,
  undefined,
  config.logRoot ? { QUOTASCOPE_LOG_ROOT: config.logRoot } : {},
);
async function importLogs() {
  status.scanning = true;
  try {
    return await importJob.run();
  } finally {
    status.scanning = false;
  }
}
const enabled = store.get<boolean>("collectionEnabled") ?? true;
const collector = new Collector(
  refresh,
  enabled,
  (state) => {
    store.set("collectionEnabled", state.enabled);
    store.set("collectorState", state);
  },
  60000,
  store.get("collectorState"),
);
const importer = new Collector(
  importLogs,
  enabled,
  (state) => store.set("importerState", state),
  300000,
  store.get("importerState"),
  900000,
);
function rescan() {
  return scanOperation.run(async () => {
    await importer.cycle(true);
    return importer.state.lastError === null;
  });
}
let backupJob: ImportJob | null = null;
let backupFlight: Promise<boolean> | null = null;
let backupAutomatic = false;
function backup(automatic: boolean): Promise<boolean> {
  if (stopping) return Promise.resolve(false);
  if (backupFlight) {
    // A manual request needs a fresh copy, not merely verification of yesterday's automatic copy.
    if (!automatic && backupAutomatic)
      return backupFlight.then(() => backup(false));
    return backupFlight;
  }
  backupAutomatic = automatic;
  backupJob = new ImportJob(
    dir,
    120000,
    new URL("./backup-worker.ts", import.meta.url),
    { QUOTASCOPE_BACKUP_MODE: automatic ? "automatic" : "manual" },
  );
  backupFlight = backupJob
    .run()
    .then((ok) => {
      if (!ok)
        store.set(
          "backupError",
          "A verified backup could not be completed. Existing history was preserved.",
        );
      return ok;
    })
    .finally(() => {
      backupFlight = null;
      backupJob = null;
    });
  return backupFlight;
}
const backupScheduler = new Collector(
  () => backup(true),
  true,
  () => {},
  3600000,
  undefined,
  3600000,
);
const dashboard = new DashboardReader(store.path);
const exporter = new ExportJob(store.path);
function statusSnapshot(): DashboardStatus {
  const current = store.get<AccountSnapshot>("accountSnapshot");
  return {
    version: 1,
    csrf,
    now: Date.now(),
    status: { ...status },
    collector: {
      ...collector.state,
      managed: process.env.QUOTASCOPE_MANAGED === "launchd",
    },
    importer: { ...importer.state },
    backup: {
      last: store.get("lastBackup") ?? null,
      error: store.get("backupError") ?? null,
      running: !!backupFlight,
    },
    operations: { scan: scanOperation.state, backup: backupOperation.state },
    attempts: store.attempts(),
    scan: store.get("scan") ?? null,
    windows: current?.windows ?? [],
    snapshotId: current?.id ?? null,
    identity: current?.identity ?? null,
  };
}
async function snapshot(query: DashboardQuery = {}) {
  const basic = statusSnapshot();
  const details = await dashboard.read(query);
  return { ...basic, ...details };
}
function dashboardQuery(url: URL): DashboardQuery {
  const timezone =
    url.searchParams.get("timezone") ??
    Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = Number(url.searchParams.get("days") ?? 30),
    view = url.searchParams.get("view") ?? "overview",
    window = url.searchParams.get("window") ?? "";
  if (
    ![7, 30, 90].includes(days) ||
    !["overview", "activity", "evidence", "comparisons"].includes(view) ||
    window.length > 200 ||
    !validTimezone(timezone)
  )
    throw Error("Invalid dashboard query");
  return {
    days: days as 7 | 30 | 90,
    view: view as DashboardQuery["view"],
    window,
    timezone,
  };
}

function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += c.length;
    if (size > 16000) throw new Error("Request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const production = process.argv.includes("--production");
const vite = production
  ? null
  : await (
      await import("vite")
    ).createServer({
      root,
      server: { middlewareMode: true, hmr: false },
      appType: "spa",
    });
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  const expectedHost = `127.0.0.1:${port}`;
  if (
    req.headers.host !== expectedHost &&
    req.headers.host !== `localhost:${port}`
  )
    return json(res, 403, { error: "Loopback host required" });
  const origin = req.headers.origin;
  if (
    origin &&
    ![`http://${expectedHost}`, `http://localhost:${port}`].includes(origin)
  )
    return json(res, 403, { error: "Origin rejected" });
  const url = new URL(req.url ?? "/", `http://${expectedHost}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "POST") {
        const token = req.headers["x-quotascope-token"];
        if (
          !origin ||
          req.headers["content-type"] !== "application/json" ||
          typeof token !== "string" ||
          token.length !== csrf.length ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))
        )
          return json(res, 403, {
            error: "Same-origin request token required",
          });
      }
      if (req.method === "GET" && url.pathname === "/api/status")
        return json(res, 200, statusSnapshot());
      if (req.method === "GET" && url.pathname === "/api/state")
        return json(res, 200, await snapshot(dashboardQuery(url)));
      if (req.method === "POST" && url.pathname === "/api/collector") {
        const b = await body(req);
        if (typeof b?.enabled !== "boolean")
          return json(res, 400, {
            error: "Choose whether background monitoring is enabled.",
          });
        collector.setEnabled(b.enabled);
        importer.setEnabled(b.enabled);
        return json(res, 200, statusSnapshot());
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        await collector.cycle(true);
        return json(res, 200, statusSnapshot());
      }
      if (req.method === "POST" && url.pathname === "/api/scan") {
        void rescan();
        return json(res, 202, {
          operation: scanOperation.state,
          message: "Local rescan is running. You can keep using the dashboard.",
        });
      }
      if (req.method === "POST" && url.pathname === "/api/annotations") {
        const b = await body(req);
        if (
          !["plan", "reset", "coverage"].includes(b.kind) ||
          !["boolean"].includes(typeof b.verified) ||
          typeof b.label !== "string" ||
          !b.label.trim() ||
          b.label.length > 160 ||
          !Number.isFinite(b.at) ||
          b.at < 0 ||
          b.at > Date.UTC(2101, 0, 1) ||
          (b.end != null &&
            (!Number.isFinite(b.end) ||
              b.end <= b.at ||
              b.end > Date.UTC(2101, 0, 1))) ||
          typeof b.account !== "string" ||
          !store.hasAccount(b.account)
        )
          return json(res, 400, {
            error:
              "Enter a valid annotation with a known account and date range.",
          });
        const a: Annotation = {
          kind: b.kind,
          at: b.at,
          end: b.end ?? null,
          account: b.account,
          label: b.label.trim(),
          verified: b.verified,
        };
        store.annotate(a);
        return json(res, 201, { message: "Evidence note saved." });
      }
      if (req.method === "POST" && url.pathname === "/api/manual") {
        const b = await body(req),
          used = numeric(b.used),
          reset = numeric(b.reset),
          duration = numeric(b.duration);
        if (
          used === null ||
          used < 0 ||
          used > 100 ||
          reset === null ||
          reset <= Date.now() / 1000 ||
          reset > Date.UTC(2101, 0, 1) / 1000 ||
          duration === null ||
          duration <= 0 ||
          duration > 52560000
        )
          return json(res, 400, {
            error: "Enter a valid percentage, future reset time and duration.",
          });
        const o: Observation = {
          account:
            store.get<AccountSnapshot>("accountSnapshot")?.account ??
            "manual-account",
          bucket: "codex",
          slot: "primary",
          at: Date.now(),
          used,
          reset,
          duration,
          plan: label(b.plan),
          source: "manual",
          resetCredits: null,
          balance: null,
        };
        store.observe(o);
        return json(res, 201, {
          message:
            "Manual observation saved to history. Reported account windows are unchanged.",
        });
      }
      if (req.method === "POST" && url.pathname === "/api/backup") {
        void backupOperation.run(() => backup(false));
        return json(res, 202, {
          operation: backupOperation.state,
          message:
            "Backup is running. Verification will be reported when it finishes.",
        });
      }
      if (req.method === "GET" && url.pathname === "/api/export") {
        return await exporter.serve(
          res,
          url.searchParams.get("format") === "csv" ? "csv" : "json",
        );
      }
      return json(res, 404, { error: "Unknown operation" });
    }
    if (req.method !== "GET")
      return json(res, 405, { error: "Method not allowed" });
    if (vite)
      return vite.middlewares(req, res, () =>
        json(res, 404, { error: "Not found" }),
      );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'",
    );
    const file = url.pathname.startsWith("/assets/")
      ? resolve(root, "dist", "." + url.pathname)
      : join(root, "dist/index.html");
    if (!file.startsWith(join(root, "dist") + "/") || !existsSync(file))
      return json(res, 404, {
        error: "Build assets unavailable; run npm run build.",
      });
    res.setHeader(
      "Content-Type",
      (
        {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        } as Record<string, string>
      )[extname(file)] ?? "application/octet-stream",
    );
    res.end(readFileSync(file));
  } catch {
    if (!res.headersSent)
      json(res, 400, {
        error:
          "The operation could not be completed. Previous observations are preserved.",
      });
    else res.end();
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`QuotaScope ready at http://127.0.0.1:${port}`);
  void collector.cycle();
  void importer.cycle();
  void backupScheduler.cycle();
});
server.on("error", () => {
  console.error(
    "QuotaScope could not bind its loopback port. Stop the other instance or choose a different PORT.",
  );
  store.close();
  process.exitCode = 1;
  void vite?.close();
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.all([
    importJob.stop(),
    backupJob?.stop(),
    dashboard.stop(),
    exporter.stop(),
  ]);
  await Promise.all([
    collector.stop(),
    importer.stop(),
    backupScheduler.stop(),
  ]);
  await Promise.allSettled([refreshing]);
  await Promise.all([scanOperation.settled(), backupOperation.settled()]);
  await vite?.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
