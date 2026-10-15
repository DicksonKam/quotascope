export interface CoverageGap {
  start: number;
  end: number;
}
export interface Coverage {
  firstSuccessAt: number | null;
  lastSuccessAt: number | null;
  thresholdMs: number;
  gapCount: number;
  gaps: CoverageGap[];
  recent?: { gaps: number; longestMs: number };
}
export function monitoringHealth(
  coverage: Coverage,
  enabled: boolean,
  failed: boolean,
  now: number,
  unreachable = false,
) {
  if (unreachable) return { kind: "warning", label: "Service unreachable" };
  if (!enabled) return { kind: "paused", label: "Monitoring paused" };
  if (failed)
    return { kind: "warning", label: "Account read failed · retry scheduled" };
  if (coverage.lastSuccessAt === null)
    return { kind: "warning", label: "Waiting for first account read" };
  if (now - coverage.lastSuccessAt > coverage.thresholdMs)
    return { kind: "warning", label: "Monitoring delayed" };
  return { kind: "healthy", label: "Monitoring healthy" };
}
// Match the interior of an interval: observations precede their saved attempt by milliseconds.
export function crossesCoverageGap(
  previousAt: number,
  currentAt: number,
  gaps: CoverageGap[],
) {
  return gaps.some(
    (g) =>
      previousAt < (g.start + g.end) / 2 && currentAt > (g.start + g.end) / 2,
  );
}
export function coverageSummary(coverage: Coverage, now: number) {
  const start = Math.max(now - 86400000, coverage.firstSuccessAt ?? now);
  const intervals = coverage.gaps
    .filter((g) => g.end > start && g.start < now)
    .map((g) => ({
      start: Math.max(start, g.start),
      end: Math.min(now, g.end),
    }));
  const ongoing =
    coverage.lastSuccessAt !== null &&
    now - coverage.lastSuccessAt > coverage.thresholdMs;
  if (ongoing)
    intervals.push({
      start: Math.max(start, coverage.lastSuccessAt!),
      end: now,
    });
  return {
    since: start,
    gaps:
      (coverage.recent?.gaps ?? intervals.length - (ongoing ? 1 : 0)) +
      (ongoing ? 1 : 0),
    longestMs: Math.max(
      coverage.recent?.longestMs ?? 0,
      0,
      ...intervals.map((g) => g.end - g.start),
    ),
    ongoing,
  };
}
