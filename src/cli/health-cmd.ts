// health subcommand: read-only diagnostic check of the telemetry database.
import fs from "fs";
import { Database } from "bun:sqlite";
import { getDbPath } from "../paths.ts";

const LATEST_SCHEMA_VERSION = 2;

// Exit codes:
//   0 — healthy (warnings possible)
//   1 — DB missing or unreadable
//   2 — schema out of date

function check(label: string, ok: boolean, value: string, warn = false): void {
  const icon = ok ? "✓" : warn ? "⚠" : "✗";
  console.log(`  ${icon}  ${label.padEnd(22)} ${value}`);
}

export function runHealth(): void {
  const dbPath = getDbPath();
  console.log("opencode-telemetry health check");
  console.log("─".repeat(50));
  console.log(`  DB path: ${dbPath}`);
  console.log();

  if (!fs.existsSync(dbPath)) {
    console.log("  ✗  DB file               not found");
    console.log();
    console.log("No telemetry database found. Run a session with opencode-telemetry installed first.");
    process.exit(1);
  }
  check("DB file", true, "exists");

  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    console.log(`  ✗  DB readable            cannot open: ${err}`);
    process.exit(1);
  }

  function q<T>(sql: string): T | null {
    try {
      return db.query(sql).get() as T;
    } catch {
      return null;
    }
  }

  // Schema version
  const metaRow = q<{ value: string }>("SELECT value FROM _meta WHERE key = 'schema_version'");
  const schemaVersion = metaRow ? parseInt(metaRow.value, 10) : 1;
  const schemaOk = schemaVersion >= LATEST_SCHEMA_VERSION;
  check(
    "Schema version",
    schemaOk,
    `${schemaVersion}  (latest: ${LATEST_SCHEMA_VERSION})${schemaOk ? "" : "  — run migration"}`,
    !schemaOk
  );

  // Row counts
  const sessions = (q<{ n: number }>("SELECT COUNT(*) AS n FROM sessions")?.n ?? 0);
  const turns = (q<{ n: number }>("SELECT COUNT(*) AS n FROM turns")?.n ?? 0);
  const tools = (q<{ n: number }>("SELECT COUNT(*) AS n FROM tool_calls")?.n ?? 0);
  check("Sessions", true, String(sessions));
  check("Turns", true, String(turns));
  check("Tool calls", true, String(tools));

  // Last write
  const lastRow = q<{ ts: string }>(
    "SELECT MAX(COALESCE(ended_at, started_at)) AS ts FROM sessions"
  );
  if (lastRow?.ts) {
    const diffMs = Date.now() - new Date(lastRow.ts).getTime();
    const diffMin = Math.round(diffMs / 60_000);
    const ago = diffMin < 60
      ? `${diffMin} min ago`
      : `${Math.round(diffMin / 60)}h ago`;
    check("Last write", true, `${lastRow.ts}  (${ago})`);
  } else {
    check("Last write", true, "no sessions yet");
  }

  // Orphan tool calls warning (turn_idx still NULL)
  const orphanRow = q<{ orphans: number; total: number }>(
    "SELECT SUM(CASE WHEN turn_idx IS NULL THEN 1 ELSE 0 END) AS orphans, COUNT(*) AS total FROM tool_calls"
  );
  if (orphanRow && orphanRow.total > 0) {
    const pct = ((orphanRow.orphans / orphanRow.total) * 100).toFixed(1);
    const high = orphanRow.orphans / orphanRow.total > 0.2;
    check(
      "Orphan turn_idx",
      !high,
      `${orphanRow.orphans} / ${orphanRow.total} tool calls (${pct}%)${high ? "  ⚠ > 20%" : ""}`,
      high
    );
  }

  // Models with no pricing (NULL est_cost_usd)
  const unpricedRow = q<{ models: string }>(
    `SELECT GROUP_CONCAT(DISTINCT model) AS models
     FROM turns WHERE session_id IN (
       SELECT session_id FROM sessions WHERE est_cost_usd IS NULL
     ) AND model IS NOT NULL`
  );
  if (unpricedRow?.models) {
    check("Missing prices", false, `models without pricing: ${unpricedRow.models}`, true);
  } else {
    check("Missing prices", true, "all priced");
  }

  db.close();

  console.log();
  if (!schemaOk) {
    console.log("Schema migration needed. Update the plugin to apply migrations automatically.");
    process.exit(2);
  }
  console.log("Status: healthy");
  process.exit(0);
}
