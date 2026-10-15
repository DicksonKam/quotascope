import { DatabaseSync } from "node:sqlite";
import { writeExport } from "./export-data.ts";

const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  await writeExport(
    db,
    process.argv[3] === "csv" ? "csv" : "json",
    process.stdout,
  );
} catch {
  process.exitCode = 1;
} finally {
  db.close();
}
