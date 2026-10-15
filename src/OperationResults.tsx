import React from "react";
import { Check, ChevronDown, CircleAlert, Clock3 } from "lucide-react";
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
  const StatusIcon = attention ? CircleAlert : running ? Clock3 : Check;
  return (
    <details
      className={`operation-results${attention ? " needs-attention" : ""}`}
      open={attention || running}
    >
      <summary>
        <span className="operation-heading">Recent requests</span>
        <span className="operation-status">
          <StatusIcon size={13} aria-hidden="true" />
          {attention
            ? "Needs attention"
            : running
              ? "In progress"
              : "Completed"}
        </span>
        <ChevronDown
          size={15}
          className="operation-chevron"
          aria-hidden="true"
        />
      </summary>
      <div className="operation-entries">
        {entries.map(([kind, state]) => (
          <p key={kind} data-operation-id={state!.id}>
            <span>
              {state!.state === "running"
                ? `${kind === "scan" ? "Local rescan" : "Backup"} is running. You can close the dashboard and check here later.`
                : operationOutcome(kind, state!, state)}
            </span>
            <time
              dateTime={new Date(
                state!.completedAt ?? state!.startedAt,
              ).toISOString()}
            >
              {date(state!.completedAt ?? state!.startedAt)}
            </time>
          </p>
        ))}
      </div>
    </details>
  );
}
