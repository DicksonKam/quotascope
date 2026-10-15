import type { ActivityScope } from "../shared/api.ts";
import type {
  AccountSnapshot,
  Observation,
  TokenEvent,
} from "../shared/types.ts";
import type { Store } from "./store.ts";

export function activityScope(
  mode: "all" | "current",
  snapshot: AccountSnapshot | undefined,
  window: Observation | undefined,
  now: number,
): ActivityScope {
  const result: ActivityScope = {
    mode,
    available: true,
    from: null,
    reset: null,
    account: null,
    reason: "All available local history across observed accounts.",
  };
  if (mode === "all") return result;
  const missing = (reason: string) => ({ ...result, available: false, reason });
  if (
    !window ||
    snapshot?.identity !== "provider" ||
    window.account !== snapshot.account ||
    window.source !== "account"
  )
    return missing(
      "A known account and a direct allowance reading are needed.",
    );
  if (now - window.at > 120000 || window.at > now + 60000)
    return missing(
      "The allowance reading is stale. Refresh usage to identify the current window.",
    );
  if (
    window.reset === null ||
    window.duration === null ||
    !Number.isFinite(window.reset) ||
    !Number.isFinite(window.duration) ||
    window.duration <= 0
  )
    return missing(
      "The provider has not supplied a usable reset time and window duration.",
    );
  const reset = window.reset * 1000,
    from = reset - window.duration * 60000;
  if (
    !Number.isSafeInteger(reset) ||
    !Number.isSafeInteger(from) ||
    from < 0 ||
    from > Math.min(now, window.at) ||
    reset <= now
  )
    return missing(
      "The reported window has expired or its timing is inconsistent. Await a fresh allowance reading.",
    );
  return {
    ...result,
    from,
    reset,
    account: window.account,
    reason:
      "Start inferred from the reported reset time minus window duration; an exact renewal was not observed.",
  };
}

export function activityEvents(
  store: Store,
  scope: ActivityScope,
  now: number,
  after?: number,
) {
  if (!scope.available)
    return { events: [] as TokenEvent[], boundaryExcluded: 0 };
  const from = Math.max(scope.from ?? 0, after ?? 0);
  const rows = store.db
    .prepare(
      `SELECT data FROM events WHERE at>=? AND at<=?${scope.account ? " AND json_extract(data,'$.account')=?" : ""} ORDER BY at`,
    )
    .all(...(scope.account ? [from, now, scope.account] : [from, now])) as {
    data: string;
  }[];
  const events = rows.map((row) => JSON.parse(row.data) as TokenEvent);
  if (scope.mode === "all") return { events, boundaryExcluded: 0 };
  // Cumulative fallback deltas cannot be reliably clipped at a window boundary.
  const eligible = events.filter(
    (event) =>
      event.kind === "response" &&
      (event.turnStart == null || event.turnStart >= scope.from!),
  );
  return {
    events: eligible,
    boundaryExcluded: events.length - eligible.length,
  };
}
