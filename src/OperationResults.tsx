import React from "react";
import type { DashboardStatus } from "../shared/api";
import { operationOutcome } from "./operations";
import { date } from "./time";

/** Outcomes come from durable server markers, including on a newly opened page. */
export function OperationResults({
  operations,
}: {
  operations: DashboardStatus["operations"];
}) {
  const entries = Object.entries(operations).filter(
    ([, state]) => state !== null,
  );
  if (!entries.length) return null;
  const attention = entries.some(
    ([, state]) => state!.state === "failed" || state!.state === "interrupted",
  );
  const running = entries.some(([, state]) => state!.state === "running");
  return (
    <details className="operation-results" open={attention || running}>
      <summary>
        Recent requests
        {attention
          ? " · Needs attention"
          : running
            ? " · In progress"
            : " · Completed"}
      </summary>
      {entries.map(([kind, state]) => (
        <p key={kind} data-operation-id={state!.id}>
          {state!.state === "running"
            ? `${kind === "scan" ? "Local rescan" : "Backup"} is running. You can close the dashboard and check here later.`
            : operationOutcome(kind, state!, state)}{" "}
          <small>{date(state!.completedAt ?? state!.startedAt)}</small>
        </p>
      ))}
    </details>
  );
}
