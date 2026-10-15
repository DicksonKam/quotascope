import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

/** One export worker at a time; client disconnect, deadline and shutdown cancel it. */
export class ExportJob {
  private child: ChildProcess | null = null;
  private flight: Promise<void> | null = null;
  private stopping = false;
  constructor(
    private path: string,
    private timeoutMs = 120000,
    private entry = new URL("./export-worker.ts", import.meta.url),
  ) {}

  serve(res: ServerResponse, format: "json" | "csv"): Promise<void> {
    if (this.child || this.stopping) {
      res.writeHead(this.stopping ? 503 : 429, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": "5",
      });
      res.end(
        JSON.stringify({
          error:
            "An export is already running or the service is stopping. Try again shortly.",
        }),
      );
      return Promise.resolve();
    }
    const child = (this.child = spawn(
      process.execPath,
      ["--import", "tsx", fileURLToPath(this.entry), this.path, format],
      { stdio: ["ignore", "pipe", "ignore"] },
    ));
    this.flight = new Promise<void>((resolve) => {
      let cancelled = false,
        killer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        child.kill("SIGTERM");
        killer = setTimeout(() => child.kill("SIGKILL"), 1500);
      };
      const timer = setTimeout(cancel, this.timeoutMs);
      res.once("close", cancel);
      res.once("error", cancel);
      child.stdout!.once("data", () => {
        res.writeHead(200, {
          "Content-Type": format === "csv" ? "text/csv" : "application/json",
          "Content-Disposition": `attachment; filename="quotascope-metadata.${format}"`,
          "Cache-Control": "no-store",
        });
      });
      child.stdout!.pipe(res, { end: false });
      child.once("error", cancel);
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killer);
        res.off("close", cancel);
        res.off("error", cancel);
        child.stdout!.unpipe(res);
        if (!res.destroyed) {
          if (code === 0 && !cancelled) res.end();
          else if (!res.headersSent) {
            res.writeHead(503, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            });
            res.end(
              JSON.stringify({
                error:
                  "Export did not complete. Try again; saved history was preserved.",
              }),
            );
          } else res.destroy(); // Never label a partial download as complete.
        }
        this.child = null;
        resolve();
      });
    }).finally(() => {
      this.flight = null;
    });
    return this.flight;
  }

  async stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 1500);
    try {
      await this.flight;
    } finally {
      clearTimeout(killer);
    }
  }
}
