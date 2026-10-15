import { randomUUID } from "node:crypto";

import type { OperationState } from "../shared/api.ts";
export type { OperationState } from "../shared/api.ts";

/** One durable completion marker for an existing single-flight worker. */
export class Operation {
  state: OperationState | null;
  private flight: Promise<boolean> | null = null;

  constructor(
    previous: OperationState | undefined,
    private save: (state: OperationState) => void,
  ) {
    this.state = previous ?? null;
    if (this.state?.state === "running") {
      this.state = {
        ...this.state,
        state: "interrupted",
        completedAt: Date.now(),
      };
      this.save(this.state);
    }
  }

  run(work: () => Promise<boolean>): Promise<boolean> {
    if (this.flight) return this.flight;
    this.state = {
      id: randomUUID(),
      state: "running",
      startedAt: Date.now(),
      completedAt: null,
    };
    this.save(this.state);
    // Defer work until flight is assigned, including synchronous failures.
    this.flight = Promise.resolve()
      .then(work)
      .catch(() => false)
      .then((ok) => {
        this.state = {
          ...this.state!,
          state: ok ? "succeeded" : "failed",
          completedAt: Date.now(),
        };
        this.save(this.state);
        return ok;
      })
      .finally(() => {
        this.flight = null;
      });
    return this.flight;
  }

  async settled(): Promise<void> {
    await this.flight;
  }
}
