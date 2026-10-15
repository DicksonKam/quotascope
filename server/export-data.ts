import type { DatabaseSync } from "node:sqlite";
import type { Writable } from "node:stream";
import { once } from "node:events";
import { csvCell } from "./privacy.ts";
import type { Observation, TokenEvent } from "../shared/types.ts";

export const exportColumns = [
  "recordType",
  "schemaVersion",
  "account",
  "thread",
  "bucket",
  "slot",
  "utc",
  "hongKong",
  "used",
  "duration",
  "reset",
  "plan",
  "source",
  "evidence",
  "model",
  "effort",
  "speed",
  "input",
  "cached",
  "cacheWrite",
  "output",
  "reasoning",
  "total",
  "quality",
];

/** A consistent read snapshot, bounded row/chunk memory, and output backpressure. */
export async function writeExport(
  db: DatabaseSync,
  format: "json" | "csv",
  output: Writable,
  now = Date.now(),
) {
  const hongKong = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let buffer = "";
  async function write(text: string, flush = false) {
    buffer += text;
    if (buffer.length < 65536 && !flush) return;
    if (!output.write(buffer)) await once(output, "drain");
    buffer = "";
  }
  // Keyset batches avoid holding a native SQLite iterator across async writes.
  // Some supported Node runtimes can finalize an iterator's statement during GC.
  function* records(table: "observations" | "events") {
    const statement = db.prepare(`SELECT rowid AS row,at,data FROM ${table}
      WHERE at>=? AND (at>? OR rowid>?) ORDER BY at,rowid LIMIT 256`);
    let at = -Number.MAX_VALUE,
      row = 0;
    while (true) {
      const batch = statement.all(at, at, row) as {
        row: number;
        at: number;
        data: string;
      }[];
      if (!batch.length) return;
      for (const item of batch) yield JSON.parse(item.data);
      ({ at, row } = batch[batch.length - 1]);
    }
  }
  function* observations() {
    for (const o of records("observations") as Generator<Observation>) {
      yield {
        ...o,
        utc: new Date(o.at).toISOString(),
        hongKong: hongKong.format(o.at),
        evidence:
          o.source === "account"
            ? "provider-observation"
            : o.source === "manual"
              ? "user-observation"
              : "local-log-observation",
      };
    }
  }
  function* events() {
    for (const e of records("events") as Generator<TokenEvent>) {
      yield {
        ...e,
        utc: new Date(e.at).toISOString(),
        hongKong: hongKong.format(e.at),
        evidence:
          e.kind === "response"
            ? "local-response-metadata"
            : "cumulative-estimate",
      };
    }
  }
  db.exec("BEGIN");
  try {
    if (format === "csv") {
      await write(exportColumns.map(csvCell).join(","));
      const csv = (row: Record<string, unknown>) =>
        "\r\n" + exportColumns.map((k) => csvCell(row[k])).join(",");
      for (const o of observations())
        await write(
          csv({
            ...o,
            recordType: "observation",
            schemaVersion: 1,
            quality: "reported-percentage;coverage-incomplete",
          }),
        );
      for (const e of events())
        await write(
          csv({
            ...e,
            recordType: e.kind,
            schemaVersion: 1,
            source: "local",
            quality: [...e.flags, "coverage-incomplete"].join(";"),
          }),
        );
    } else {
      await write(
        JSON.stringify({
          schemaVersion: 1,
          generatedAt: new Date(now).toISOString(),
          timezone: "Asia/Hong_Kong",
          coverage: "Incomplete local coverage; no official quota is inferred",
        }).slice(0, -1),
      );
      async function array(name: string, rows: Iterable<unknown>) {
        await write(`,${JSON.stringify(name)}:[`);
        let first = true;
        for (const row of rows) {
          await write((first ? "" : ",") + JSON.stringify(row));
          first = false;
        }
        await write("]");
      }
      await array("observations", observations());
      await array("events", events());
      function* annotations() {
        let before = Number.MAX_SAFE_INTEGER;
        const statement = db.prepare(
          "SELECT id,data FROM annotations WHERE id<? ORDER BY id DESC LIMIT 256",
        );
        while (true) {
          const batch = statement.all(before) as { id: number; data: string }[];
          if (!batch.length) return;
          for (const row of batch)
            yield { ...JSON.parse(row.data), id: row.id };
          before = batch[batch.length - 1].id;
        }
      }
      await array("annotations", annotations());
      // Issue codes are an allowlisted, small vocabulary; the raw issue ledger is not loaded.
      await array(
        "issues",
        db
          .prepare(
            "SELECT code,count(*) AS count FROM issues GROUP BY code ORDER BY count DESC",
          )
          .all(),
      );
      await write("}");
    }
    await write("", true);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
