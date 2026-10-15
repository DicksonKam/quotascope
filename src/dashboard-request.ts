import type {
  DashboardResponse,
  DashboardStatus,
  DashboardState,
} from "../shared/api";
export async function requestDashboard(
  query: string,
  fetcher: typeof fetch = fetch,
): Promise<
  | { data: DashboardResponse; partial: false }
  | { data: DashboardStatus; partial: true }
> {
  try {
    const response = await fetcher("/api/state?" + query, {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("Details unavailable");
    return { data: await response.json(), partial: false };
  } catch {
    const status = await fetcher("/api/status", {
      signal: AbortSignal.timeout(5000),
    });
    if (!status.ok) throw Error("Service unavailable");
    return { data: await status.json(), partial: true };
  }
}

export function mergeDashboardStatus(
  previous: DashboardState | null,
  status: DashboardStatus,
): DashboardState {
  const sameSnapshot = previous?.snapshotId === status.snapshotId;
  return {
    ...previous,
    ...status,
    query: undefined,
    detailsDelayed: true,
    latest: status.windows?.[0],
    // Details from a previous account/snapshot must never be applied to new windows.
    windowHistories: sameSnapshot ? (previous?.windowHistories ?? []) : [],
    history: sameSnapshot ? (previous?.history ?? []) : [],
    localHistory: sameSnapshot ? (previous?.localHistory ?? []) : [],
    coverage: sameSnapshot ? previous?.coverage : undefined,
    rate: {
      value: null,
      reason: "Dashboard details are delayed",
      hours: 0,
      samples: 0,
      exhaustionHours: null,
    },
  };
}
