export { parseWallTime, validTimezone } from "../shared/time";
import { validTimezone } from "../shared/time";
export const timezonePreference = () => {
  const saved =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem("qs-timezone");
  return saved && validTimezone(saved)
    ? saved
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
};
export const date = (at: number, opts: Intl.DateTimeFormatOptions = {}) =>
  new Date(at).toLocaleString("en-GB", {
    timeZone: timezonePreference(),
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...opts,
  });
