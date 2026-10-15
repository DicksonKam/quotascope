export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return value.length <= 100;
  } catch {
    return false;
  }
}
const dayFormats = new Map<string, Intl.DateTimeFormat>();
export function dayKey(at: number, timezone: string): string {
  let format = dayFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormats.set(timezone, format);
    if (dayFormats.size > 16)
      dayFormats.delete(dayFormats.keys().next().value!);
  }
  const parts = format.formatToParts(at);
  return ["year", "month", "day"]
    .map((kind) => parts.find((part) => part.type === kind)!.value)
    .join("-");
}
/** Calendar arithmetic, so a DST day is not treated as a fixed 24-hour day. */
export function dayCutoff(now: number, timezone: string, days = 90): string {
  const date = new Date(dayKey(now, timezone) + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() - days + 1);
  return date.toISOString().slice(0, 10);
}
/** Reject nonexistent and repeated wall times rather than silently shifting a user's note. */
export function parseWallTime(value: string, timezone: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) || !validTimezone(timezone))
    return NaN;
  const wall = Date.parse(value + ":00Z");
  if (
    !Number.isFinite(wall) ||
    new Date(wall).toISOString().slice(0, 16) !== value
  )
    return NaN;
  const format = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const wallString = (at: number) => format.format(at).replace(" ", "T");
  const candidates = new Set<number>();
  // Offset candidates on both sides of a transition; handles half-hour changes too.
  for (const hours of [-36, 0, 36]) {
    const sample = wall + hours * 3600000;
    const offset = Date.parse(wallString(sample) + ":00Z") - sample;
    const candidate = wall - offset;
    if (wallString(candidate) === value) candidates.add(candidate);
  }
  return candidates.size === 1 ? [...candidates][0] : NaN;
}
