import type { CollectorState } from "../shared/api.ts";
export type { CollectorState } from "../shared/api.ts";
export class Collector {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private stopped = false;
  state: CollectorState;
  constructor(
    private collect: () => Promise<boolean>,
    enabled: boolean,
    private save: (state: CollectorState) => void,
    private intervalMs = 60000,
    previous?: Partial<CollectorState>,
    private maxDelayMs = 300000,
  ) {
    this.state = {
      enabled,
      running: false,
      intervalMs,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
      lastError: null,
      failureSince: previous?.failureSince ?? null,
      recoveredAt: previous?.recoveredAt ?? null,
      failures: previous?.failures ?? 0,
    };
  }
  private persist() {
    this.save({ ...this.state });
  }
  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.state.nextRunAt = null;
  }
  private schedule() {
    this.clear();
    if (this.stopped || !this.state.enabled) return;
    const delay = Math.min(
      this.maxDelayMs,
      this.intervalMs * 2 ** Math.min(4, this.state.failures),
    );
    this.state.nextRunAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      void this.cycle();
    }, delay);
    this.persist();
  }
  cycle(manual = false): Promise<void> {
    if (this.flight) return this.flight;
    if (this.stopped || (!this.state.enabled && !manual))
      return Promise.resolve();
    this.clear();
    this.state.running = true;
    this.state.lastStartedAt = Date.now();
    this.persist();
    this.flight = (async () => {
      let ok = false;
      try {
        ok = await this.collect();
      } catch {
        /* Keep background failures bounded and metadata-only. */
      }
      if (ok && this.state.failureSince !== null)
        this.state.recoveredAt = Date.now();
      this.state.failureSince = ok
        ? null
        : (this.state.failureSince ?? Date.now());
      this.state.failures = ok ? 0 : this.state.failures + 1;
      this.state.lastError = ok
        ? null
        : "Collection did not complete. Retrying automatically.";
      this.state.running = false;
      this.state.lastCompletedAt = Date.now();
      this.persist();
    })().finally(() => {
      this.flight = null;
      this.schedule();
    });
    return this.flight;
  }
  setEnabled(enabled: boolean) {
    this.state.enabled = enabled;
    this.clear();
    this.persist();
    if (enabled && !this.stopped) void this.cycle();
  }
  async stop() {
    this.stopped = true;
    this.clear();
    await this.flight;
    this.state.running = false;
    this.state.nextRunAt = null;
    this.persist();
  }
}
