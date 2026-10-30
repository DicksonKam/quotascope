import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { numeric, label } from "./privacy.ts";
import type { AccountSnapshot, Observation } from "../shared/types.ts";
import { sortWindows, windowKey } from "../shared/allowance.ts";

/**
 * A failed account read. Transient failures can clear without the user doing anything: the network is not back
 * after a wake or a move between networks, the helper was slow, or its connection dropped. Codex reports an
 * unreachable backend as unavailable usage, so that reply is transient too. A missing CLI or a malformed reply
 * is not, and keeps the collector's longer backoff.
 */
export class AccountReadError extends Error {
  constructor(
    message: string,
    readonly transient: boolean,
  ) {
    super(message);
  }
}
export function readAccount(
  timeoutMs = 20000,
  executable = process.env.QUOTASCOPE_CODEX ?? "codex",
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      ["app-server", "--listen", "stdio://", "-c", "analytics.enabled=false"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const end = (error?: Error, data?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill("SIGTERM");
      const killer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1500);
      killer.unref();
      if (error) reject(error);
      else resolve(data);
    };
    const timer = setTimeout(
      () =>
        end(
          new AccountReadError(
            "Account read timed out. Local history remains available.",
            true,
          ),
        ),
      timeoutMs,
    );
    child.on("error", () =>
      end(
        new AccountReadError(
          "Codex CLI is unavailable. Set QUOTASCOPE_CODEX to its executable path.",
          false,
        ),
      ),
    );
    child.on("exit", () => {
      if (!finished)
        end(
          new AccountReadError(
            "Account connection closed. Check that Codex is signed in.",
            true,
          ),
        );
    });
    const send = (obj: unknown) => {
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(obj) + "\n");
    };
    child.stdin.on("error", () =>
      end(new AccountReadError("Account connection unavailable.", true)),
    );
    lines.on("line", (line) => {
      if (line.length > 2_000_000)
        return end(
          new AccountReadError(
            "Account response exceeded the supported size.",
            false,
          ),
        );
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id === 1) {
        if (msg.error)
          return end(
            new AccountReadError("Account initialization failed.", false),
          );
        send({ method: "initialized" });
        send({ id: 2, method: "account/rateLimits/read" });
      } else if (msg.id === 2) {
        if (msg.error)
          return end(
            new AccountReadError(
              "Account usage is unavailable. If this persists, sign in through Codex; QuotaScope does not change authentication.",
              true,
            ),
          );
        end(undefined, msg.result);
      } else if (msg.method && msg.id != null) {
        // Reject every server-initiated action. This adapter only reads account limits.
        send({
          id: msg.id,
          error: {
            code: -32601,
            message: "Unsupported by read-only QuotaScope",
          },
        });
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "quotascope",
          title: "QuotaScope",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: true },
      },
    });
  });
}
export function accountObservations(
  raw: any,
  hash: (v: unknown) => string,
  at = Date.now(),
): Observation[] {
  if (!raw || typeof raw !== "object")
    throw new Error("Invalid account response.");
  // The installed app-server schema defines accountId as a nullable, backend-supplied
  // identity for this exact usage snapshot. Never infer it from plan, email or old reads.
  const known =
    typeof raw.accountId === "string" && /^\S{1,512}$/u.test(raw.accountId);
  const account = known ? hash(raw.accountId) : `unattributed:${randomUUID()}`;
  const buckets =
    raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length
      ? raw.rateLimitsByLimitId
      : { [raw.rateLimits?.limitId ?? "codex"]: raw.rateLimits };
  const result: Observation[] = [];
  for (const [key, b] of Object.entries(buckets) as [string, any][]) {
    if (!b) continue;
    for (const slot of ["primary", "secondary"] as const) {
      const w = b[slot],
        used = numeric(w?.usedPercent);
      if (used === null || used < 0 || used > 100) continue;
      result.push({
        account,
        identity: known ? "provider" : "unknown",
        bucket: label(key),
        slot,
        at,
        used,
        duration: numeric(w.windowDurationMins),
        reset: numeric(w.resetsAt),
        plan: b.planType ? label(b.planType) : null,
        source: "account",
        resetCredits: numeric(raw.rateLimitResetCredits?.availableCount),
        balance:
          typeof b.credits?.balance === "string" &&
          /^\d+(\.\d+)?$/.test(b.credits.balance)
            ? b.credits.balance
            : null,
      });
    }
  }
  if (!result.length)
    throw new Error("Account returned no supported allowance windows.");
  return result;
}

export function accountSnapshot(
  raw: unknown,
  hash: (v: unknown) => string,
  previous?: AccountSnapshot,
  at = Date.now(),
): AccountSnapshot {
  const windows = sortWindows(accountObservations(raw, hash, at));
  const id = randomUUID(),
    account = windows[0].account,
    identity = windows[0].identity!;
  const membership = (values: Observation[]) =>
    JSON.stringify(sortWindows(values).map((o) => [windowKey(o), o.duration]));
  const continuous =
    identity === "provider" &&
    previous?.identity === "provider" &&
    previous.account === account &&
    membership(previous.windows) === membership(windows);
  const continuity = continuous ? previous.continuity : id;
  return {
    id,
    at,
    account,
    identity,
    continuity,
    windows: windows.map((o) => ({ ...o, continuity })),
  };
}
