import type { OperationState } from "../shared/api";
export function operationOutcome(
  kind: string,
  requested: OperationState,
  observed: OperationState | null | undefined,
): string | null {
  // Status fetched before the accepted request can still be visible during the next render.
  if (
    !observed ||
    (observed.id !== requested.id && observed.startedAt <= requested.startedAt)
  )
    return null;
  const name = kind === "scan" ? "Local rescan" : "Backup";
  if (observed.id !== requested.id)
    return `${name} outcome is no longer available. Check the latest status before trying again.`;
  if (observed.state === "running") return null;
  return observed.state === "succeeded"
    ? `${name} completed successfully${kind === "backup" ? " and was verified" : ""}.`
    : `${name} ${observed.state}. Existing history was preserved.`;
}
