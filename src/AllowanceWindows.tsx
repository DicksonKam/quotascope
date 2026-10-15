import React from "react";
import { date, timezonePreference } from "./time";
import type { Observation } from "../shared/types";
import { windowKey, windowLabel } from "../shared/allowance";
import { remainingPercent } from "../shared/history";

export function resetCountdown(reset: number | null, now: number): string {
  if (reset === null) return "Reset unavailable";
  const minutes = Math.max(0, Math.ceil((reset * 1000 - now) / 60000));
  if (!minutes) return "Awaiting reset confirmation";
  const days = Math.floor(minutes / 1440),
    hours = Math.floor(minutes / 60) % 24;
  return `Resets in ${days ? `${days}d ` : ""}${hours}h ${minutes % 60}m`;
}

export function AllowanceWindows({
  windows,
  now,
  unavailable,
}: {
  windows: Observation[];
  now: number;
  unavailable: boolean;
}) {
  if (!windows.length)
    return (
      <section className="card">
        <h3>Awaiting reported allowance</h3>
        <p>
          Refresh usage to load the current windows. Previously saved history
          remains available in your export.
        </p>
      </section>
    );
  return (
    <section
      aria-label="Reported allowance windows"
      className="allowance-windows"
    >
      {windows.map((w) => {
        const stale = unavailable || now - w.at > 120000;
        const remaining = remainingPercent(w.used);
        return (
          <article
            className="allowance-panel"
            key={windowKey(w)}
            aria-label={windowLabel(w)}
          >
            <div className="panel-top">
              <h2>{windowLabel(w)}</h2>
              <span className="plan-chip">{w.plan ?? "Plan unavailable"}</span>
            </div>
            <div className="window-balance">
              <strong>
                {remaining}
                <span>%</span>
              </strong>
              <span>remaining</span>
            </div>
            <div className="quota-track">
              <div style={{ width: `${remaining}%` }} />
            </div>
            <p className="window-freshness">
              {stale ? "Stale reading" : "Last read"} ·{" "}
              {Math.max(0, Math.floor((now - w.at) / 60000))}m ago
            </p>
            <div className="allowance-footer">
              <strong>{resetCountdown(w.reset, now)}</strong>
              {w.reset !== null && (
                <time dateTime={new Date(w.reset * 1000).toISOString()}>
                  {date(w.reset * 1000)} {timezonePreference()}
                </time>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
