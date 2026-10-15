export interface HistoryObservation {
  at: number;
  used: number;
  reset: number | null;
  account?: string;
  continuity?: string;
  chartSegment?: number;
}
export const remainingPercent = (used: number) =>
  Math.min(100, Math.max(0, 100 - used));
export function historyBoundary(
  previous: HistoryObservation,
  current: HistoryObservation,
  maxInterval = 6 * 3600000,
): string | null {
  if (
    previous.chartSegment !== undefined &&
    current.chartSegment !== undefined &&
    previous.chartSegment !== current.chartSegment
  )
    return "Observation gap or allowance window change; intervening values are unknown";
  if (
    previous.account !== current.account ||
    previous.continuity !== current.continuity
  )
    return "Account or observation continuity changed; intervening usage is unknown";
  if (
    previous.reset !== null &&
    current.reset !== null &&
    Math.abs(current.reset - previous.reset) > 60
  )
    return "Reported allowance window changed; exact reset time and cause are unconfirmed";
  if (current.used < previous.used)
    return "Usage counter decreased; possible reset or reporting adjustment";
  if (current.at - previous.at > maxInterval)
    return "No observations between these points";
  return null;
}
