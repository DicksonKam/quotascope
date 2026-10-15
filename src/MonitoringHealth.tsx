import type { CollectorState } from "../shared/api";
import type { Attempt } from "../shared/types";
import React from "react";
import {
  monitoringHealth,
  coverageSummary,
  type Coverage,
} from "../shared/monitoring";
import { date, timezonePreference } from "./time";
const timestamp = (at: number) => date(at, { second: "2-digit" });
const span = (ms: number) =>
  ms < 60000
    ? `${Math.floor(ms / 1000)}s`
    : ms < 3600000
      ? `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`
      : `${Math.floor(ms / 3600000)}h ${Math.floor(ms / 60000) % 60}m`;
export function MonitoringHealth({
  coverage,
  collector,
  attempt,
  now,
  unreachable,
  importer,
  onRetry,
  onReconnect,
  busy,
  detailed = false,
}: {
  coverage: Coverage;
  collector: CollectorState;
  attempt: Attempt | undefined;
  now: number;
  unreachable: boolean;
  importer: CollectorState | undefined;
  onRetry: () => void;
  onReconnect: () => void;
  busy: boolean;
  detailed?: boolean;
}) {
  const accountHealth = monitoringHealth(
    coverage,
    collector.enabled,
    attempt?.ok === false,
    now,
    unreachable,
  );
  const health =
    accountHealth.kind === "healthy" && importer?.lastError
      ? { kind: "warning", label: "Local activity import incomplete" }
      : accountHealth;
  const summary = coverageSummary(coverage, now);
  const ongoing =
    coverage.lastSuccessAt !== null &&
    now - coverage.lastSuccessAt > coverage.thresholdMs;
  return (
    <section
      className={`card monitoring-health ${health.kind}`}
      aria-label="Monitoring health"
    >
      <div className="monitoring-summary">
        <div>
          <h3>
            <span className="status-dot" />
            {health.label}
          </h3>
          <p>
            {coverage.lastSuccessAt !== null
              ? `Last successful account read: ${timestamp(coverage.lastSuccessAt)} ${timezonePreference()} · ${span(Math.max(0, now - coverage.lastSuccessAt))} ago`
              : "No successful account readings recorded yet."}
          </p>
        </div>
        <span className="tag">
          {unreachable
            ? "Service connection lost"
            : collector.enabled
              ? "Checks every minute while awake"
              : "Paused · manual refresh available"}
        </span>
      </div>
      <div className="monitoring-facts">
        <div>
          <span>
            {summary.since === now - 86400000
              ? "Past 24 hours"
              : "Since monitoring began"}
          </span>
          <strong>
            {summary.gaps === 0
              ? "No recorded gaps"
              : `${summary.gaps} ${summary.gaps === 1 ? "gap" : "gaps"} · longest ${span(summary.longestMs)}`}
          </strong>
        </div>
        <div>
          <span>
            {unreachable
              ? "Live status"
              : collector.running
                ? "Checking now"
                : collector.enabled
                  ? "Next check"
                  : "Background checks"}
          </span>
          <strong>
            {unreachable
              ? "Unavailable until reconnected"
              : collector.running
                ? "Reading account allowance…"
                : collector.enabled && collector.nextRunAt
                  ? `In ${span(Math.max(0, collector.nextRunAt - now))}`
                  : collector.enabled
                    ? "Scheduling…"
                    : "Paused by you"}
          </strong>
        </div>
      </div>
      {!unreachable &&
        collector.enabled &&
        collector.recoveredAt &&
        now - collector.recoveredAt < 900000 &&
        attempt?.ok !== false && (
          <p className="recovery-note">
            Connection recovered at {timestamp(collector.recoveredAt)}{" "}
            {timezonePreference()}. Automatic checks have resumed.
          </p>
        )}
      {accountHealth.kind === "warning" && (
        <div className="monitoring-action">
          <p>
            {unreachable
              ? "The dashboard cannot reach the local service. Saved readings are preserved."
              : attempt?.ok === false
                ? attempt.message.includes("CLI is unavailable")
                  ? "Set QUOTASCOPE_CODEX to the installed Codex executable, reinstall the service, then try again. Run npm run doctor for setup checks."
                  : "Checks retry automatically, up to five minutes apart. Open Codex and check sign-in, then try again."
                : "The latest reading is overdue. This can happen after sleep; the service will check again automatically."}
          </p>
          <button
            className="button"
            disabled={busy}
            onClick={unreachable ? onReconnect : onRetry}
          >
            {unreachable ? "Reconnect" : "Try now"}
          </button>
        </div>
      )}
      {importer?.lastError && (
        <p>
          Local activity import is incomplete. Saved progress is preserved.{" "}
          {collector.enabled
            ? "The importer will retry automatically; allowance checks run separately."
            : "Resume monitoring to retry."}
        </p>
      )}
      {!collector.enabled && (
        <p>
          Background checks and local imports are paused. Turn on background
          monitoring above to resume. Refresh usage still takes a single
          reading.
        </p>
      )}
      {detailed && (
        <details>
          <summary>
            Coverage history · {coverage.gapCount} completed{" "}
            {coverage.gapCount === 1 ? "gap" : "gaps"}
            {ongoing ? " · current gap ongoing" : ""}
          </summary>
          <p>
            A gap means more than two minutes between successful account reads.
            It measures time between readings, not an exact outage duration.
            This is collector availability across sign-ins, not continuous
            coverage of one account. Sleep, pauses, connection failures or a
            stopped service may cause one; the cause is not inferred. No
            coverage is claimed before the first successful read
            {coverage.firstSuccessAt !== null
              ? ` (${timestamp(coverage.firstSuccessAt)} ${timezonePreference()})`
              : ""}
            .
          </p>
          {ongoing && (
            <div className="coverage-gap">
              <strong>Ongoing · {span(now - coverage.lastSuccessAt!)}</strong>
              <span>
                Since {timestamp(coverage.lastSuccessAt!)}{" "}
                {timezonePreference()} · allowance during this interval is
                unknown
              </span>
            </div>
          )}
          {!coverage.gapCount && !ongoing && (
            <p>
              No intervals longer than two minutes recorded between account
              reads.
            </p>
          )}
          {coverage.gaps.slice(0, 20).map((g) => (
            <div className="coverage-gap" key={`${g.start}-${g.end}`}>
              <strong>{span(g.end - g.start)} between reads</strong>
              <span>
                {timestamp(g.start)} → {timestamp(g.end)} {timezonePreference()}{" "}
                · values between readings unknown
              </span>
            </div>
          ))}
          {coverage.gapCount > 20 && (
            <p>Showing the latest 20 of {coverage.gapCount} recorded gaps.</p>
          )}
        </details>
      )}
    </section>
  );
}
