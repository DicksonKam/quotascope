import type { ActionResponse } from "../shared/api";
export async function performAction(
  path: string,
  payload: unknown,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<ActionResponse> {
  const send = (value: string) =>
    fetcher(`/api/${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: {
        "Content-Type": "application/json",
        "X-QuotaScope-Token": value,
      },
      body: JSON.stringify(payload),
    });
  let response = await send(token);
  // Retry only a rejected request, which has not performed its operation. Never replay on a timeout or transport error.
  if (response.status === 403) {
    const state = await fetcher("/api/status", {
      signal: AbortSignal.timeout(10000),
    });
    if (!state.ok)
      throw Error("Reconnect to the local service, then try again.");
    const fresh = await state.json();
    response = await send(fresh.csrf);
  }
  const result = await response.json();
  if (!response.ok) throw Error(result.error ?? "Operation failed");
  return result;
}

/** Read results issued before a control action must not undo its displayed state. */
export class DashboardRequests {
  private generation = 0;
  private action = false;
  private activeRead: { key: string; generation: number } | null = null;
  beginRead(key?: string): number | null {
    if (this.action || (key !== undefined && this.activeRead?.key === key))
      return null;
    const generation = ++this.generation;
    this.activeRead = key === undefined ? null : { key, generation };
    return generation;
  }
  endRead(generation: number): void {
    if (this.activeRead?.generation === generation) this.activeRead = null;
  }
  isCurrent(generation: number): boolean {
    return generation === this.generation && !this.action;
  }
  beginAction(): boolean {
    if (this.action) return false;
    this.action = true;
    this.activeRead = null;
    ++this.generation;
    return true;
  }
  endAction(): void {
    this.action = false;
  }
}
