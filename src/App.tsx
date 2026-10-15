import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  Database,
  FileCheck2,
  Fingerprint,
  Gauge,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  Moon,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sun,
  TrendingUp,
  X,
} from "lucide-react";
import type { DashboardState } from "../shared/api";
import type { Annotation, Observation } from "../shared/types";
import { historyBoundary, remainingPercent } from "../shared/history";
import { performAction, DashboardRequests } from "./request";
import { requestDashboard, mergeDashboardStatus } from "./dashboard-request";
import { MonitoringHealth } from "./MonitoringHealth";
import { AllowanceWindows } from "./AllowanceWindows";
import { windowKey, windowLabel } from "../shared/allowance";
import { crossesCoverageGap, type CoverageGap } from "../shared/monitoring";
import { date, timezonePreference, parseWallTime, validTimezone } from "./time";
import { OperationResults } from "./OperationResults";
import { ObservationDialog } from "./ObservationDialog";
import { Chart } from "./HistoryChart";

const compact = (n: number) =>
  Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
const num = (n: number) => Intl.NumberFormat("en").format(n);
const elapsed = (n: number, now: number) => {
  const s = Math.max(0, Math.floor((now - n) / 1000));
  return s < 60
    ? `${s}s ago`
    : s < 3600
      ? `${Math.floor(s / 60)}m ago`
      : `${Math.floor(s / 3600)}h ago`;
};
const nav = [
  { name: "Overview", icon: LayoutDashboard },
  { name: "Details", icon: Fingerprint },
];
const detailPages = ["Activity", "Evidence", "Comparisons"];

export function App() {
  const [timezone, setTimezone] = useState(timezonePreference);
  const [selectedWindow, setSelectedWindow] = useState("");
  const [activityScope, setActivityScope] = useState<"all" | "current">("all");
  const [data, setData] = useState<DashboardState | null>(null),
    [page, setPage] = useState("Overview"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [unreachable, setUnreachable] = useState(false),
    [notice, setNotice] = useState(""),
    [now, setNow] = useState(Date.now()),
    [form, setForm] = useState<"annotation" | "manual" | null>(null),
    [dark, setDark] = useState(localStorage.getItem("qs-theme") === "dark"),
    [historySource, setHistorySource] = useState("account"),
    [range, setRange] = useState("30");
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("qs-theme", dark ? "dark" : "light");
  }, [dark]);
  const requests = useRef(new DashboardRequests());
  async function load() {
    const sequence = requests.current.beginRead();
    if (sequence === null) return;
    const params = new URLSearchParams({
      view: page.toLowerCase(),
      activityScope,
      days: range === "current" ? "30" : range,
      historyScope: range === "current" ? "current" : "range",
      window: selectedWindow,
      timezone,
    });
    try {
      const result = await requestDashboard(params.toString());
      if (requests.current.isCurrent(sequence)) {
        setData((previous: DashboardState | null) =>
          result.partial
            ? mergeDashboardStatus(previous, result.data)
            : result.data,
        );
        setError(
          result.partial
            ? "Dashboard details are delayed. Current allowance and monitoring status are still available."
            : "",
        );
        setUnreachable(false);
      }
    } catch {
      if (requests.current.isCurrent(sequence)) {
        setUnreachable(true);
        setError(
          "Cannot load the dashboard. Showing the last loaded observations.",
        );
      }
    }
  }
  const loadRef = useRef(load);
  loadRef.current = load;
  async function action(path: string, payload: unknown = {}) {
    if (!requests.current.beginAction()) return;
    setBusy(path);
    setNotice("");
    setError("");
    try {
      const result = await performAction(path, payload, data!.csrf);
      setUnreachable(false);
      if (result.version !== undefined) {
        setData((previous) => mergeDashboardStatus(previous, result));
      } else {
        setNotice(result.message ?? "Operation completed.");
        if (result.operation && (path === "scan" || path === "backup")) {
          const operation = result.operation;
          setData(
            (previous) =>
              previous && {
                ...previous,
                operations: { ...previous.operations, [path]: operation },
              },
          );
        }
      }
      if (["manual", "annotations"].includes(path)) setForm(null);
    } catch (e) {
      if (e instanceof TypeError) setUnreachable(true);
      setError(
        e instanceof TypeError
          ? "Cannot reach the local service. The last successful observation is preserved."
          : (e as Error).message,
      );
    } finally {
      requests.current.endAction();
      setBusy("");
      void loadRef.current();
    }
  }
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    const p = setInterval(() => {
      if (!document.hidden) void loadRef.current();
    }, 15000);
    return () => {
      clearInterval(i);
      clearInterval(p);
    };
  }, []);
  useEffect(() => {
    const resume = () => {
      if (!document.hidden) void loadRef.current();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, []);
  useEffect(() => {
    void loadRef.current();
  }, [page, range, selectedWindow, timezone, activityScope]);
  const runningRequest =
    data?.operations.scan?.state === "running" ||
    data?.operations.backup?.state === "running";
  useEffect(() => {
    if (!runningRequest) return;
    const timer = setInterval(() => {
      void loadRef.current();
    }, 2000);
    return () => clearInterval(timer);
  }, [runningRequest]);
  const windows: Observation[] = data?.windows ?? [];
  const latest =
    windows.find((w) => windowKey(w) === selectedWindow) ?? windows[0];
  useEffect(() => {
    if (windows.length && !windows.some((w) => windowKey(w) === selectedWindow))
      setSelectedWindow(windowKey(windows[0]));
  }, [data, selectedWindow]);
  const selectedHistory = data?.windowHistories?.find(
    (h: { key: string }) => latest && h.key === windowKey(latest),
  );
  const viewReady =
    data?.query?.view === page.toLowerCase() &&
    data.query.timezone === timezone &&
    (page !== "Activity" ||
      ((data.query.activityScope ?? "all") === activityScope &&
        data.query.window === (latest ? windowKey(latest) : "")));
  const usage = data?.usage,
    attempt = data?.attempts?.[0];
  const fresh =
    latest?.source === "account" &&
    now - latest.at < 120000 &&
    attempt?.ok !== false &&
    (!error || data?.detailsDelayed);
  const observedRate = selectedHistory?.rate ?? data?.rate;
  const rate = observedRate
    ? fresh
      ? observedRate
      : {
          ...observedRate,
          value: null,
          reason: "Latest observation is stale",
          exhaustionHours: null,
        }
    : null;
  const historyReady =
    data?.query?.days === (range === "current" ? 30 : Number(range)) &&
    (data.query.historyScope ?? "range") ===
      (range === "current" ? "current" : "range") &&
    data?.query?.window === (latest ? windowKey(latest) : "");
  const allHistory: Observation[] = !historyReady
    ? []
    : historySource === "account"
      ? (selectedHistory?.history ?? [])
      : (selectedHistory?.localHistory ?? []);
  const points = allHistory
    .filter((p) =>
      range === "current"
        ? data?.cycle?.available === true &&
          p.at >= (data.cycle.from ?? Infinity)
        : p.at >= now - Number(range) * 86400000,
    )
    .map((p) => ({ ...p, remaining: remainingPercent(p.used) }));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("Overview");
          }}
        >
          <span className="brand-symbol">
            <Gauge size={23} />
          </span>
          <span>
            QuotaScope
            <span className="brand-caption">PERSONAL OBSERVATORY</span>
          </span>
        </a>
        <div className="workspace">
          <span className="avatar">
            <Gauge size={15} />
          </span>
          <div>
            Your workspace<small>Local account monitor</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map((n) => (
            <button
              key={n.name}
              aria-current={
                (
                  n.name === "Overview"
                    ? page === "Overview"
                    : page !== "Overview"
                )
                  ? "page"
                  : undefined
              }
              className={
                (
                  n.name === "Overview"
                    ? page === "Overview"
                    : page !== "Overview"
                )
                  ? "selected"
                  : ""
              }
              onClick={() =>
                setPage(n.name === "Details" ? "Evidence" : "Overview")
              }
            >
              <n.icon size={18} />
              {n.name}
              {n.name === "Comparisons" && (
                <span className="tiny-tag">LAB</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private">
            <ShieldCheck size={19} />
            <div>
              Private by design<small>Usage metadata stays on this Mac.</small>
            </div>
          </div>
          <button className="theme-control" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={17} /> : <Moon size={17} />}{" "}
            {dark ? "Light appearance" : "Dark appearance"}
          </button>
          <div className="version">
            QUOTASCOPE <span>v0.1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-label">
              <span className="status-dot" /> Local on this Mac
            </span>
            <button
              className="mobile-theme"
              aria-label={
                dark
                  ? "Switch to light appearance"
                  : "Switch to dark appearance"
              }
              onClick={() => setDark(!dark)}
            >
              {dark ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <span className="account-avatar">
              <Gauge size={14} />
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div className="eyebrow">YOUR CODEX ALLOWANCE, IN PERSPECTIVE</div>
            <div className="heading-row">
              <div>
                <h1>
                  {page === "Overview"
                    ? "Room to build."
                    : page === "Activity"
                      ? "Every token tells a story."
                      : page === "Evidence"
                        ? "Know what you know."
                        : "Let the evidence lead."}
                </h1>
                <p>
                  {page === "Overview"
                    ? "A clear view of what you use, what remains, and what comes next."
                    : page === "Activity"
                      ? "Locally observed usage, with the details that matter."
                      : page === "Evidence"
                        ? "Sources, gaps, and the assumptions behind the numbers."
                        : "Compare like with like. Leave uncertainty visible."}
                </p>
              </div>
              <button
                className="button primary"
                disabled={!!busy || !data}
                onClick={() => void action("refresh")}
              >
                <RefreshCw
                  size={15}
                  className={busy === "refresh" ? "spin" : ""}
                />{" "}
                {busy === "refresh" ? "Refreshing…" : "Refresh usage"}
              </button>
            </div>
          </div>
          <div className="freshness">
            <span className={fresh ? "status-dot" : "status-dot muted-dot"} />
            <span>
              {latest
                ? `${latest.source === "account" && !fresh ? "Stale · " : ""}${latest.source === "account" ? "Account observation" : latest.source === "manual" ? "Manual observation" : "Local log observation"} · ${elapsed(latest.at, now)}`
                : "Connecting to your usage data…"}
            </span>
            <span className="divider" />
            <label>
              <input
                type="checkbox"
                checked={data?.collector?.enabled ?? false}
                disabled={!data || !!busy}
                onChange={(e) =>
                  void action("collector", { enabled: e.target.checked })
                }
              />{" "}
              {data?.collector?.enabled
                ? "Background monitoring on"
                : "Background monitoring paused"}
            </label>
            {data?.status.scanning && (
              <span className="scanning">
                <LoaderCircle size={13} className="spin" /> Updating local
                activity
              </span>
            )}
          </div>
          <div aria-live="polite">
            {error && (
              <div className="banner error" role="alert">
                {error}
              </div>
            )}
            {notice && <div className="banner">{notice}</div>}
            {data && <OperationResults operations={data.operations} />}
            {attempt && !attempt.ok && page !== "Overview" && (
              <div className="banner warning">
                Account refresh unavailable. {attempt.message}{" "}
                <button onClick={() => setForm("manual")}>
                  Add a manual snapshot
                </button>
              </div>
            )}
          </div>
          {page !== "Overview" && (
            <nav className="detail-tabs" aria-label="Details sections">
              {detailPages.map((name) => (
                <button
                  key={name}
                  aria-current={page === name ? "page" : undefined}
                  className={page === name ? "selected" : ""}
                  onClick={() => setPage(name)}
                >
                  {name}
                </button>
              ))}
            </nav>
          )}
          {!data ? (
            unreachable ? (
              <section className="card">
                <h2>Start the local service</h2>
                <p>
                  Run <code>npm start</code> from QuotaScope, then reconnect. If
                  setup needs attention, run <code>npm run doctor</code>.
                </p>
                <button className="button" onClick={() => void load()}>
                  Reconnect
                </button>
              </section>
            ) : (
              <div className="loading">
                <LoaderCircle className="spin" /> Loading your observatory…
              </div>
            )
          ) : (
            <>
              {page !== "Overview" && !viewReady && (
                <div className="loading">Loading {page.toLowerCase()}…</div>
              )}
              {page === "Overview" && (
                <>
                  <AllowanceWindows
                    windows={windows}
                    now={now}
                    unavailable={
                      unreachable ||
                      (!!error && !data.detailsDelayed) ||
                      attempt?.ok === false
                    }
                  />
                  {data.identity === "unknown" && (
                    <div className="banner warning">
                      Account identity is unavailable for this reading. Current
                      balances are shown; readings are kept separate and account
                      trends are paused until the provider identifies the
                      account.
                    </div>
                  )}
                  {data.coverage && (
                    <MonitoringHealth
                      coverage={data.coverage}
                      collector={data.collector}
                      attempt={attempt}
                      now={now}
                      unreachable={unreachable}
                      importer={data.importer}
                      busy={!!busy}
                      onRetry={() => void action("refresh")}
                      onReconnect={() => void load()}
                    />
                  )}
                  {data.backup?.error && (
                    <div className="banner warning">
                      Local backup needs attention. Your current history is
                      preserved.{" "}
                      <button onClick={() => setPage("Evidence")}>
                        Review
                      </button>
                    </div>
                  )}
                  <details className="history-details">
                    <summary>Allowance history</summary>
                    <section className="card history-card">
                      <div className="card-heading">
                        <div>
                          <h3>Remaining allowance over time</h3>
                          <p>
                            {latest
                              ? windowLabel(latest)
                              : "Awaiting an account read"}
                          </p>
                        </div>
                        <div className="chart-controls">
                          {windows.length > 1 && (
                            <select
                              aria-label="Allowance window"
                              value={latest ? windowKey(latest) : ""}
                              onChange={(e) =>
                                setSelectedWindow(e.target.value)
                              }
                            >
                              {windows.map((w) => (
                                <option key={windowKey(w)} value={windowKey(w)}>
                                  {windowLabel(w)}
                                </option>
                              ))}
                            </select>
                          )}
                          <div className="segmented">
                            <button
                              className={
                                historySource === "local" ? "active" : ""
                              }
                              onClick={() => setHistorySource("local")}
                            >
                              Local logs
                            </button>
                            <button
                              className={
                                historySource === "account" ? "active" : ""
                              }
                              onClick={() => setHistorySource("account")}
                            >
                              Account reads
                            </button>
                          </div>
                          <select
                            aria-label="History range"
                            value={range}
                            onChange={(e) => setRange(e.target.value)}
                          >
                            <option value="current">Current cycle</option>
                            <option value="7">7 days</option>
                            <option value="30">30 days</option>
                            <option value="90">90 days</option>
                          </select>
                        </div>
                      </div>
                      {(historySource === "account"
                        ? selectedHistory?.historyTruncated
                        : selectedHistory?.localHistoryTruncated) && (
                        <p className="subtle-note">
                          Frequent window changes limit this chart to its most
                          recent portion. Full history remains in your export.
                        </p>
                      )}
                      {!historyReady && (
                        <p className="subtle-note">Loading selected history…</p>
                      )}
                      {historySource === "local" &&
                        historyReady &&
                        !points.length && (
                          <p className="subtle-note">
                            No local observations are linked to this account and
                            window. Unattributed or different-account logs are
                            kept separate.
                          </p>
                        )}
                      {range === "current" && historyReady && (
                        <p className="subtle-note" role="status">
                          {data?.cycle?.available &&
                          data.cycle.from !== null ? (
                            <>
                              Inferred cycle start: {date(data.cycle.from)} ·{" "}
                              {timezone}.{" "}
                            </>
                          ) : null}
                          {data?.cycle?.reason ??
                            "Awaiting current cycle timing."}
                        </p>
                      )}
                      <Chart
                        points={points}
                        label={`Remaining allowance from ${historySource} · ${range === "current" ? "current inferred cycle" : `last ${range} days`}`}
                        coverageGaps={
                          historySource === "account"
                            ? data.coverage?.gaps
                            : undefined
                        }
                      />
                      <div className="chart-caption">
                        <span>
                          <span className="legend-line" /> Remaining allowance ·{" "}
                          {points.length} observations{" "}
                          <span className="legend-gap" /> Gap or window change
                        </span>
                        <span>
                          {historySource === "local"
                            ? "Local logs · selected account and bucket"
                            : "Direct account reads"}{" "}
                          · Dashed = uncertain between observations
                        </span>
                      </div>
                    </section>
                  </details>
                </>
              )}
              {page === "Activity" && (
                <section className="card">
                  <div className="card-heading">
                    <div>
                      <h3>Activity period</h3>
                      <p>
                        Recorded local tokens, not shares of allowance consumed.
                      </p>
                    </div>
                    <div className="chart-controls">
                      <select
                        aria-label="Activity period"
                        value={activityScope}
                        onChange={(e) =>
                          setActivityScope(e.target.value as "all" | "current")
                        }
                      >
                        <option value="all">All history</option>
                        <option value="current">
                          Current allowance window
                        </option>
                      </select>
                      {activityScope === "current" && windows.length > 1 && (
                        <select
                          aria-label="Activity allowance window"
                          value={latest ? windowKey(latest) : ""}
                          onChange={(e) => setSelectedWindow(e.target.value)}
                        >
                          {windows.map((w) => (
                            <option key={windowKey(w)} value={windowKey(w)}>
                              {windowLabel(w)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                  {!viewReady ? (
                    <p className="subtle-note">
                      Loading selected activity period…
                    </p>
                  ) : activityScope === "current" && data?.activityScope ? (
                    <div className="subtle-note" role="status">
                      {data.activityScope.available &&
                        data.activityScope.from !== null && (
                          <p>
                            {latest && windowLabel(latest)} · Inferred start:{" "}
                            {date(data.activityScope.from)} · Next reset:{" "}
                            {date(data.activityScope.reset!)} · {timezone}
                          </p>
                        )}
                      <p>{data.activityScope.reason}</p>
                      {data.activityScope.available && (
                        <p>
                          Selected account only. Known turns crossing the start
                          and cumulative estimates are excluded (
                          {usage?.boundaryExcluded ?? 0} records). Responses
                          with unknown start times use completion time.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="subtle-note">
                      All available imported local history, including logs from
                      before installation.
                    </p>
                  )}
                </section>
              )}
              {page === "Activity" &&
                viewReady &&
                usage &&
                (activityScope === "all" ||
                  data?.activityScope?.available === true) && (
                  <>
                    <div className="metric-strip">
                      <div>
                        <span>Input tokens</span>
                        <strong>{compact(usage.input)}</strong>
                      </div>
                      <div>
                        <span>Cached input subset</span>
                        <strong>{compact(usage.cached)}</strong>
                      </div>
                      <div>
                        <span>Output tokens</span>
                        <strong>{compact(usage.output)}</strong>
                      </div>
                      <div>
                        <span>Reasoning output subset</span>
                        <strong>{compact(usage.reasoning)}</strong>
                      </div>
                    </div>
                    <section className="card">
                      <div className="card-heading">
                        <div>
                          <h3>Daily local token activity</h3>
                          <p>
                            {activityScope === "current"
                              ? "Within the inferred window · selected account · chart limited to the past 90 days"
                              : "Past 90 days · all locally observed accounts"}{" "}
                            · {timezone} calendar days
                          </p>
                        </div>
                        <span className="tag">
                          {usage.days[0]?.first
                            ? date(usage.days[0].first, {
                                hour: undefined,
                                minute: undefined,
                              })
                            : "Awaiting history"}{" "}
                          onwards
                        </span>
                      </div>
                      <Chart
                        points={usage.days.map((d) => ({
                          at: d.first,
                          total: d.total,
                        }))}
                        field="total"
                        unit="Tokens / day"
                        label="Daily locally observed input plus output tokens"
                      />
                      <p className="subtle-note">
                        Observed over the last wall-clock hour:{" "}
                        {compact(usage.recentTokensPerMinute)} tokens/min.
                        Missing log activity is not included.
                      </p>
                    </section>
                    <p className="subtle-note">
                      Legacy-only estimates: {compact(usage.fallbackTokens)}{" "}
                      tokens across {num(usage.fallbackRecords)} cumulative
                      deltas. These estimates are excluded from the response
                      totals.
                    </p>
                    <div className="section-title">
                      <h2>Usage by model</h2>
                      <span>
                        {activityScope === "current"
                          ? "Current inferred window"
                          : "All available local history"}{" "}
                        · {usage.excluded} anomalous records excluded
                      </span>
                    </div>
                    {usage.modelsTruncated && (
                      <p className="subtle-note">
                        Showing the 50 models with the most observed tokens.
                      </p>
                    )}
                    <section className="card model-list">
                      {usage.byModel.map((m) => (
                        <div className="model-row" key={m.name}>
                          <div className="model-symbol">
                            <Layers3 size={18} />
                          </div>
                          <div className="model-name">
                            <strong>{m.name}</strong>
                            <small>
                              {num(m.responses)} responses
                              {m.system
                                ? " · System activity; metering unverified"
                                : ""}
                            </small>
                          </div>
                          <div className="model-bar">
                            <div
                              style={{
                                width: `${Math.max(1, (m.total / Math.max(1, usage.total)) * 100)}%`,
                              }}
                            />
                          </div>
                          <strong className="model-value">
                            {compact(m.total)}
                            <small>
                              tokens ·{" "}
                              {(
                                (m.total / Math.max(1, usage.total)) *
                                100
                              ).toFixed(1)}
                              % of recorded tokens
                            </small>
                          </strong>
                        </div>
                      ))}
                    </section>
                    {usage.settingsTruncated && (
                      <p className="subtle-note">
                        Showing the 100 settings groups with the most observed
                        tokens.
                      </p>
                    )}
                    <details className="settings-detail">
                      <summary>Recorded model settings</summary>
                      <p className="subtle-note">
                        Unknown speed or effort remains unknown. These groups
                        describe metadata, not independently measured allowance
                        factors.
                      </p>
                      {(usage.bySettings ?? []).map((s) => (
                        <div className="detail-row" key={s.name}>
                          <span>{s.name}</span>
                          <strong>{compact(s.total)} tokens</strong>
                        </div>
                      ))}
                    </details>
                    <div className="section-title">
                      <h2>Sessions</h2>
                      <span>Up to 40 sessions · pseudonymous identifiers</span>
                    </div>
                    <section className="card session-list">
                      {usage.sessions.map((s) => (
                        <div className="session-row" key={s.name}>
                          <span className="mono">{s.name.slice(0, 10)}</span>
                          <span>{s.models.join(", ")}</span>
                          <span>{date(s.last)}</span>
                          <strong>{compact(s.total)}</strong>
                        </div>
                      ))}
                    </section>
                  </>
                )}
              {page === "Evidence" && viewReady && rate && (
                <>
                  {data.coverage && (
                    <MonitoringHealth
                      detailed
                      coverage={data.coverage}
                      collector={data.collector}
                      attempt={attempt}
                      now={now}
                      unreachable={unreachable}
                      importer={data.importer}
                      busy={!!busy}
                      onRetry={() => void action("refresh")}
                      onReconnect={() => void load()}
                    />
                  )}{" "}
                  <section className="card pace-card">
                    <div className="card-heading">
                      <span className="overline">YOUR RECENT PACE</span>
                      <TrendingUp size={18} />
                    </div>
                    <p>
                      {latest
                        ? windowLabel(latest)
                        : "Awaiting an account read"}
                    </p>
                    <div className="pace-value">
                      {rate.value === null ? "—" : rate.value.toFixed(2)}
                      <span>pp / hour</span>
                    </div>
                    <p>
                      {rate.value === null
                        ? "A little more observation is needed."
                        : `Based on ${rate.samples} observations over ${rate.hours.toFixed(1)} wall-clock hours.`}
                    </p>
                    <p>
                      {rate.value === null
                        ? rate.reason
                        : "Recent consumption can change. No exhaustion time is predicted."}
                    </p>
                    <div className="subtle-note">
                      Percentage-point rate · rounded account readings
                    </div>
                  </section>
                  <div className="evidence-intro">
                    <ShieldCheck size={30} />
                    <div>
                      <h2>Useful observations. Honest boundaries.</h2>
                      <p>
                        Current account readings and local token records answer
                        different questions. Coverage is incomplete until
                        independently established.
                      </p>
                    </div>
                  </div>
                  <div className="two-columns">
                    <section className="card">
                      <div className="card-heading">
                        <h3>Data sources</h3>
                        <Database size={18} />
                      </div>
                      <div className="detail-row">
                        <span>Background collector</span>
                        <strong>
                          {data.collector?.enabled
                            ? "Independent account checks"
                            : "Paused"}
                        </strong>
                      </div>
                      <div className="detail-row">
                        <span>Service launch</span>
                        <strong>
                          {data.collector?.managed
                            ? "macOS login agent"
                            : "Manual process"}
                        </strong>
                      </div>
                      <div className="detail-row">
                        <span>Next background cycle</span>
                        <strong>
                          {data.collector?.nextRunAt
                            ? date(data.collector.nextRunAt)
                            : data.collector?.running
                              ? "Collecting now"
                              : "Paused"}
                        </strong>
                      </div>
                      <div className="detail-row">
                        <span>Account adapter</span>
                        <strong>
                          {attempt?.ok ? "Connected" : "Unavailable"}
                        </strong>
                      </div>
                      <div className="detail-row">
                        <span>Local import status</span>
                        <strong>
                          {data.importer?.lastError
                            ? "Retrying separately"
                            : data.importer?.running
                              ? "Importing"
                              : "Ready"}
                        </strong>
                      </div>
                      <div className="detail-row">
                        <span>Local activity files</span>
                        <strong>{data.scan?.files ?? "Scanning"}</strong>
                      </div>
                      <div className="detail-row">
                        <span>Indexed logs missing</span>
                        <strong>
                          {data.scan?.indexedMissing ?? "Not checked"}
                        </strong>
                      </div>
                      <div className="detail-row">
                        <span>Last scan</span>
                        <strong>
                          {data.scan
                            ? elapsed(data.scan.at, now)
                            : "In progress"}
                        </strong>
                      </div>
                      <div className="detail-row">
                        <span>Last scan bytes read</span>
                        <strong>
                          {data.scan ? compact(data.scan.bytes) : "—"}
                        </strong>
                      </div>
                      <p>
                        {latest?.resetCredits ?? "Unavailable"} banked reset
                        credits reported. QuotaScope never redeems them. Source
                        logs are read-only. Prompts, code, titles, and
                        credentials are excluded. Cross-device and cloud
                        activity may be missing.
                      </p>
                      <button
                        className="button"
                        disabled={
                          !!busy || data.operations?.scan?.state === "running"
                        }
                        onClick={() => void action("scan")}
                      >
                        <RefreshCw
                          size={14}
                          className={busy === "scan" ? "spin" : ""}
                        />{" "}
                        Rescan local metadata
                      </button>
                    </section>
                    <section className="card">
                      <div className="card-heading">
                        <h3>Accounting checks</h3>
                        <FileCheck2 size={18} />
                      </div>
                      {(data.issues ?? []).map((i) => (
                        <div className="detail-row" key={i.code}>
                          <span>{i.code.replaceAll("-", " ")}</span>
                          <strong>{num(i.count)}</strong>
                        </div>
                      ))}
                      {!data.issues?.length && (
                        <p>No accounting issues have been recorded.</p>
                      )}
                      <p>
                        Response IDs deduplicate activity. Repeated cumulative
                        values are corroboration, never a second additive
                        ledger. Cache-write and inconsistent records are
                        excluded from trusted totals.
                      </p>
                    </section>
                  </div>
                  <div className="section-title">
                    <h2>Recent window boundaries</h2>
                    <span>
                      Latest 10,000 observations · causes remain unknown
                    </span>
                  </div>
                  <section className="card boundary-list">
                    {(data.segments ?? []).slice(0, 12).map((s, i: number) => (
                      <div className="boundary" key={i}>
                        <span className="boundary-dot" />
                        <div>
                          <strong>{s.reason.replaceAll("-", " ")}</strong>
                          <small>
                            {s.source} · {s.plan ?? "Unknown plan"} · {s.bucket}
                            /{s.slot}
                          </small>
                        </div>
                        <span>{date(s.start)}</span>
                        <strong>
                          {s.min}–{s.max}%
                        </strong>
                      </div>
                    ))}
                  </section>
                  <div className="section-title">
                    <h2>Refresh history</h2>
                    <span>
                      Attempts are retained even when account reads fail
                    </span>
                  </div>
                  <section className="card">
                    {data.attempts.map((a, i: number) => (
                      <div className="detail-row" key={i}>
                        <span>
                          {a.ok ? (
                            <Check size={13} />
                          ) : (
                            <CircleHelp size={13} />
                          )}{" "}
                          {a.message}
                        </span>
                        <span>{date(a.at)}</span>
                      </div>
                    ))}
                  </section>
                  <section
                    className="card backup-status"
                    aria-label="Local backups"
                  >
                    <h3>Automatic local backups</h3>
                    <p>
                      {data.backup?.last
                        ? `Last verified copy: ${date(data.backup.last.at)} ${timezonePreference()}`
                        : "The first verified copy is being prepared."}
                    </p>
                    <p>
                      Saved daily on this Mac. Seven automatic copies are kept;
                      older verified automatic copies move to Trash. Manual
                      copies are kept.
                    </p>
                    {data.backup?.running && (
                      <p>Creating and checking a snapshot…</p>
                    )}
                    {data.backup?.error && (
                      <p className="form-error">{data.backup.error}</p>
                    )}
                    {data.backup?.last?.retentionWarning && (
                      <p>{data.backup.last.retentionWarning}</p>
                    )}
                    <p>
                      To restore, use the documented restore command with a new
                      data folder. The current history is never overwritten.
                    </p>
                  </section>
                  <div className="section-title">
                    <h2>Your metadata, portable</h2>
                  </div>
                  <div className="actions">
                    <a className="button" href="/api/export?format=json">
                      <ArrowDownToLine size={15} /> Export JSON
                    </a>
                    <a className="button" href="/api/export?format=csv">
                      <ArrowDownToLine size={15} /> Export CSV
                    </a>
                    <button
                      className="button"
                      disabled={
                        !!busy || data.operations?.backup?.state === "running"
                      }
                      onClick={() => void action("backup")}
                    >
                      <Database size={15} /> Save private backup
                    </button>
                    <button
                      className="text-button"
                      onClick={() => setForm("manual")}
                    >
                      Add manual snapshot
                    </button>
                  </div>
                </>
              )}
              {page === "Comparisons" && viewReady && data.comparison && (
                <>
                  <section className="comparison-state">
                    <div className="comparison-mark">
                      <Layers3 size={26} />
                    </div>
                    <span className="overline">ALLOWANCE RESEARCH</span>
                    <h2>{data.comparison.status}</h2>
                    <p>
                      Does a plan change give you more actual capacity? Compare
                      the same model, reasoning effort, speed setting, and cache
                      mix across verified plan periods.
                    </p>
                    <div className="criteria">
                      <span>
                        <Check size={14} /> Reconciled tokens
                      </span>
                      <span>
                        <Check size={14} /> Matched settings
                      </span>
                      <span>
                        <Check size={14} /> Three independent windows per cohort
                      </span>
                    </div>
                  </section>
                  {data.comparison.truncated && (
                    <p className="subtle-note">
                      Showing up to 50 comparisons and 100 cohorts.
                    </p>
                  )}
                  {data.comparison.pairs.map((p, i: number) => (
                    <section className="card" key={i}>
                      <h3>
                        {p.before} → {p.after}
                      </h3>
                      <strong>
                        {p.ratio.toFixed(2)}× descriptive token-per-percentage
                        ratio
                      </strong>
                      <p>{p.model} · matched settings and cache band</p>
                    </section>
                  ))}
                  <div className="two-columns">
                    <section className="card">
                      <h3>What makes an interval eligible?</h3>
                      <p>
                        At least five percentage points over five minutes,
                        direct account reads, one known model/settings
                        combination, a verified plan period, and user-confirmed
                        coverage. Metering lag and integer rounding still apply.
                      </p>
                      {Object.entries(data.comparison.rejected).map(
                        ([reason, count]) => (
                          <div className="rejection" key={reason}>
                            <span>{reason}</span>
                            <strong>{String(count)}</strong>
                          </div>
                        ),
                      )}
                      <p className="subtle-note">
                        No fixed official token quota or billing price is
                        inferred from a plan code.
                      </p>
                    </section>
                    <section className="card">
                      <div className="card-heading">
                        <h3>Plan and coverage notes</h3>
                        <button
                          className="text-button"
                          onClick={() => setForm("annotation")}
                        >
                          <Plus size={14} /> Add note
                        </button>
                      </div>
                      <p>
                        Record a verified plan period, a known coverage
                        interval, or evidence about a reset. Showing up to 100
                        recent notes. Notes are user statements, separate from
                        provider observations.
                      </p>
                      {(data.annotations ?? []).map((a: Annotation) => (
                        <div className="annotation" key={a.id}>
                          <span className="tag">
                            {a.kind} ·{" "}
                            {a.verified ? "user confirmed" : "unverified"}
                          </span>
                          <strong>{a.label}</strong>
                          <small>
                            {date(a.at)}
                            {a.end ? " → " + date(a.end) : ""}
                          </small>
                        </div>
                      ))}
                    </section>
                  </div>
                  {data.comparison.cohorts.map((c, i: number) => (
                    <section className="card" key={i}>
                      <h3>
                        {c.plan} · {c.model}
                      </h3>
                      <p>
                        {num(Math.round(c.median))} tokens per observed
                        percentage point · range {compact(c.min)}–
                        {compact(c.max)} · {c.windows} independent windows ·{" "}
                        {c.qualified
                          ? "Qualified descriptive cohort"
                          : "More independent windows required"}
                      </p>
                    </section>
                  ))}
                  <p className="footnote">{data.comparison.caveat}</p>
                </>
              )}
            </>
          )}
          <footer>
            <label>
              Timezone{" "}
              <select
                aria-label="Timezone"
                value={timezone}
                onChange={(e) => {
                  if (validTimezone(e.target.value)) {
                    localStorage.setItem("qs-timezone", e.target.value);
                    setTimezone(e.target.value);
                  }
                }}
              >
                {[
                  ...new Set([
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                    "UTC",
                    "Asia/Hong_Kong",
                    "America/New_York",
                    "Europe/London",
                  ]),
                ].map((zone) => (
                  <option key={zone}>{zone}</option>
                ))}
              </select>
            </label>
            <span>
              <ShieldCheck size={13} /> Local metadata. Clear provenance.
            </span>
            <span>Times in {timezone} · UTC preserved</span>
          </footer>
        </main>
      </div>
      {form && data && (
        <ObservationDialog
          form={form}
          data={data}
          timezone={timezone}
          busy={!!busy}
          error={error}
          setError={setError}
          onClose={() => setForm(null)}
          onSave={action}
        />
      )}
    </div>
  );
}
