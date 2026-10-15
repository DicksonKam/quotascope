import type { Observation } from "./types.ts";

export const windowKey = (o: Pick<Observation, "bucket" | "slot">) =>
  JSON.stringify([o.bucket, o.slot]);

// Presentation order is stable across response order and percentage changes. No
// cross-bucket minimum is presented as a universal allowance.
export function sortWindows(windows: Observation[]): Observation[] {
  return [...windows].sort((a, b) => {
    if (a.bucket !== b.bucket) {
      if (a.bucket === "codex") return -1;
      if (b.bucket === "codex") return 1;
      return a.bucket < b.bucket ? -1 : 1;
    }
    return (
      (a.duration ?? Infinity) - (b.duration ?? Infinity) ||
      (a.slot === b.slot ? 0 : a.slot === "primary" ? -1 : 1)
    );
  });
}

export function windowLabel(
  o: Pick<Observation, "bucket" | "slot" | "duration">,
): string {
  const minutes = o.duration;
  const interval =
    minutes && minutes > 0
      ? minutes % 1440 === 0
        ? `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`
        : minutes % 60 === 0
          ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
          : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
      : `${o.slot === "primary" ? "Primary" : "Secondary"} window`;
  return `${o.bucket === "codex" ? "Codex" : o.bucket} · ${interval}`;
}
