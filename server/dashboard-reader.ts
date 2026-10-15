import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { DashboardQuery, DashboardDetails } from "../shared/api.ts";
export type { DashboardQuery } from "../shared/api.ts";

// One reader process keeps synchronous SQLite/analysis work away from collection.
// Requests are reads only; identical simultaneous polls share a single result.
export class DashboardReader {
  private child: ChildProcess | null = null;
  private sequence = 0;
  private stopped = false;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<
    number,
    {
      resolve: (value: DashboardDetails) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private flights = new Map<string, Promise<DashboardDetails>>();
  metrics: { pid: number; rssBytes: number; peakRssBytes: number } | null =
    null;
  constructor(
    private path: string,
    private timeoutMs = 15000,
    private idleMs = 120000,
  ) {}
  private fail() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        Error(
          "Dashboard details are temporarily unavailable. Monitoring continues.",
        ),
      );
    }
    this.pending.clear();
  }
  private start() {
    if (this.child) return this.child;
    const child = fork(
      fileURLToPath(new URL("./dashboard-worker.ts", import.meta.url)),
      [this.path],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    this.child = child;
    child.on("message", (message: any) => {
      const request = this.pending.get(message?.id);
      if (!request) return;
      this.metrics = message.metrics ?? null;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (!this.pending.size)
        this.idle = setTimeout(() => {
          if (this.child === child && !this.pending.size) {
            this.child = null;
            child.disconnect();
          }
        }, this.idleMs);
      if (message.error)
        request.reject(
          Error(
            "Dashboard details are temporarily unavailable. Monitoring continues.",
          ),
        );
      else request.resolve(message.result);
    });
    const failed = () => {
      if (this.child === child) {
        this.child = null;
        this.fail();
      }
    };
    child.once("error", failed);
    child.once("exit", failed);
    return child;
  }
  read(query: DashboardQuery = {}): Promise<DashboardDetails> {
    if (this.stopped) return Promise.reject(Error("Dashboard reader stopped."));
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const key = JSON.stringify(query),
      existing = this.flights.get(key);
    if (existing) return existing;
    if (this.pending.size >= 8)
      return Promise.reject(Error("Dashboard is busy. Try again shortly."));
    const flight = new Promise<DashboardDetails>((resolve, reject) => {
      const child = this.start(),
        id = ++this.sequence;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        if (this.child === child) {
          this.child = null;
          this.fail();
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, query }, (error) => {
        if (error && this.child === child) {
          child.kill("SIGTERM");
          this.child = null;
          this.fail();
        }
      });
    }).finally(() => this.flights.delete(key));
    this.flights.set(key, flight);
    return flight;
  }
  async stop() {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.fail();
    if (!child) return;
    await new Promise<void>((resolve) => {
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1500);
      child.once("exit", () => {
        clearTimeout(killer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
