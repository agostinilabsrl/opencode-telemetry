import { getDbPath } from "../paths.ts";
import { openDatabase } from "../../scripts/db-compat.ts";
import type { ParsedArgs } from "./args.ts";
import fs from "fs";

export function runSql(parsed: ParsedArgs): void {
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) { console.error("No telemetry database found."); process.exit(1); }

  const fileFlag = parsed.flags.get("file");
  let sql: string;

  if (typeof fileFlag === "string") {
    if (!fs.existsSync(fileFlag)) { console.error(`File not found: ${fileFlag}`); process.exit(1); }
    sql = fs.readFileSync(fileFlag, "utf8");
  } else if (parsed.subcommand) {
    sql = [parsed.subcommand, ...parsed.positionals].join(" ");
  } else {
    console.error('Usage: octm sql "<query>" or octm sql --file <path>');
    process.exit(1);
  }

  // Read-only guard: allow only SELECT / WITH / EXPLAIN
  const trimmed = sql.trim().toUpperCase();
  if (!/^(SELECT|WITH|EXPLAIN|PRAGMA)/.test(trimmed)) {
    console.error("Only SELECT/WITH/EXPLAIN/PRAGMA queries are allowed.");
    process.exit(1);
  }

  const db = openDatabase(dbPath);
  try {
    const rows = db.query(sql).all({});
    console.log(JSON.stringify(rows, null, 2));
  } catch (err) {
    console.error("Query failed:", err);
    process.exit(1);
  } finally {
    db.close();
  }
}
