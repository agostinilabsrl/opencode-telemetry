// Uses bun:sqlite (built-in, zero-dependency). Requires Bun runtime.
import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { getDbPath } from "./paths.ts";
import type { TurnRow, ToolCallRow } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  parent_session_id   TEXT,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  primary_agent       TEXT,
  slash_command       TEXT,
  project_path        TEXT,
  worktree_path       TEXT,
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cached_read   INTEGER DEFAULT 0,
  total_cached_write  INTEGER DEFAULT 0,
  total_reasoning     INTEGER DEFAULT 0,
  total_turns         INTEGER DEFAULT 0,
  total_tool_calls    INTEGER DEFAULT 0,
  est_cost_usd        REAL,
  schema_version      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);
CREATE INDEX IF NOT EXISTS idx_sessions_slash_command ON sessions(slash_command) WHERE slash_command IS NOT NULL;

CREATE TABLE IF NOT EXISTS turns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  turn_idx            INTEGER NOT NULL,
  message_id          TEXT,
  agent               TEXT,
  model               TEXT,
  provider_id         TEXT,
  thinking_level      TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cached_read_tokens  INTEGER,
  cached_write_tokens INTEGER,
  reasoning_tokens    INTEGER,
  latency_ms          INTEGER,
  finish_reason       TEXT,
  created_at          TEXT NOT NULL,
  UNIQUE(session_id, turn_idx)
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_agent_model ON turns(agent, model);
CREATE INDEX IF NOT EXISTS idx_turns_created_at ON turns(created_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  turn_idx          INTEGER,
  tool_name         TEXT NOT NULL,
  skill_name        TEXT,
  args_size_bytes   INTEGER,
  result_size_bytes INTEGER,
  duration_ms       INTEGER,
  status            TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_skill ON tool_calls(skill_name) WHERE skill_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at);

CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '3');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
`;

interface Migration {
  version: number;
  up(db: Database): void;
}

// Each entry runs inside a transaction. Use PRAGMA table_info to check column
// existence before ALTER TABLE — never swallow errors with bare try/catch.
const MIGRATIONS: Migration[] = [
  {
    version: 2,
    up(db) {
      try { db.exec("ALTER TABLE sessions ADD COLUMN slash_command TEXT"); } catch { /* already exists */ }
      try { db.exec("ALTER TABLE turns ADD COLUMN parent_tool_call_id TEXT"); } catch { /* already exists */ }
      try { db.exec("ALTER TABLE tool_calls ADD COLUMN tool_call_id TEXT"); } catch { /* already exists */ }
      try { db.exec("ALTER TABLE tool_calls ADD COLUMN spawned_session_id TEXT"); } catch { /* already exists */ }
      try { db.exec("ALTER TABLE sessions ADD COLUMN server_url TEXT"); } catch { /* already exists */ }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_turns_parent_tool ON turns(parent_tool_call_id) WHERE parent_tool_call_id IS NOT NULL"); } catch { /* ignore */ }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_id ON tool_calls(tool_call_id) WHERE tool_call_id IS NOT NULL"); } catch { /* ignore */ }
      try { db.exec("CREATE INDEX IF NOT EXISTS idx_tool_calls_spawned ON tool_calls(spawned_session_id) WHERE spawned_session_id IS NOT NULL"); } catch { /* ignore */ }
    },
  },
  {
    version: 3,
    up(db) {
      // Use PRAGMA table_info to guard ALTER TABLE — avoids silent failures from
      // v2 try/catch that could have bumped schema_version without adding the column.
      const sessionCols = db.query("PRAGMA table_info(sessions)").all() as { name: string }[];
      const colNames = new Set(sessionCols.map(c => c.name));
      if (!colNames.has("slash_command")) {
        db.exec("ALTER TABLE sessions ADD COLUMN slash_command TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_slash_command ON sessions(slash_command) WHERE slash_command IS NOT NULL");
      }
      // Backfill primary_agent from turns for sessions still showing NULL.
      db.exec(`
        UPDATE sessions
        SET primary_agent = (
          SELECT agent FROM turns
          WHERE session_id = sessions.session_id AND agent IS NOT NULL
          GROUP BY agent ORDER BY COUNT(*) DESC LIMIT 1
        )
        WHERE primary_agent IS NULL
          AND EXISTS (
            SELECT 1 FROM turns WHERE session_id = sessions.session_id AND agent IS NOT NULL
          )
      `);
      // Derive slash_command from primary_agent for all sessions that still lack it.
      db.exec(`
        UPDATE sessions
        SET slash_command = '/' || primary_agent
        WHERE primary_agent IS NOT NULL AND (slash_command IS NULL OR slash_command = '')
      `);
    },
  },
];

function runMigrations(db: Database): void {
  const row = db.query("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string } | null;
  const currentVersion = row ? parseInt(row.value, 10) : 1;
  const pending = MIGRATIONS.filter(m => m.version > currentVersion);
  for (const migration of pending) {
    try {
      db.transaction(() => {
        migration.up(db);
        db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run("schema_version", String(migration.version));
      })();
    } catch (err) {
      console.warn(`[opencode-telemetry] migration to v${migration.version} failed, stopping:`, err);
      break;
    }
  }
}

export interface DbHandle {
  insertTurn(row: TurnRow): void;
  upsertSession(fields: {
    session_id: string;
    parent_session_id?: string | null;
    started_at: string;
    primary_agent?: string | null;
    project_path?: string | null;
    worktree_path?: string | null;
    server_url?: string | null;
  }): void;
  updatePrimaryAgent(session_id: string, agent: string): void;
  incrementSessionTurns(session_id: string, cost: number | null, input: number, output: number, cached_read: number, cached_write: number, reasoning: number): void;
  insertToolCall(row: ToolCallRow): void;
  incrementSessionToolCalls(session_id: string): void;
  finalizeSession(session_id: string): void;
  linkOrphanToolCalls(session_id: string, turn_idx: number, window_start: string, window_end: string): void;
  getMaxTurnIdx(session_id: string): number;
  schemaVersion(): number;
  getServerUrl(): string | null;
  close(): void;
}

export function initDatabase(): DbHandle {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(SCHEMA);
  runMigrations(db);

  const stmtUpsertSession = db.prepare(`
    INSERT INTO sessions (session_id, parent_session_id, started_at, primary_agent, project_path, worktree_path, server_url)
    VALUES ($session_id, $parent_session_id, $started_at, $primary_agent, $project_path, $worktree_path, $server_url)
    ON CONFLICT(session_id) DO NOTHING
  `);

  const stmtInsertTurn = db.prepare(`
    INSERT OR IGNORE INTO turns
      (session_id, turn_idx, message_id, parent_tool_call_id, agent, model, provider_id, thinking_level,
       input_tokens, output_tokens, cached_read_tokens, cached_write_tokens,
       reasoning_tokens, latency_ms, finish_reason, created_at)
    VALUES
      ($session_id, $turn_idx, $message_id, $parent_tool_call_id, $agent, $model, $provider_id, $thinking_level,
       $input_tokens, $output_tokens, $cached_read_tokens, $cached_write_tokens,
       $reasoning_tokens, $latency_ms, $finish_reason, $created_at)
  `);

  const stmtIncrementSessionTurns = db.prepare(`
    UPDATE sessions SET
      total_turns         = total_turns + 1,
      total_input_tokens  = total_input_tokens + $input,
      total_output_tokens = total_output_tokens + $output,
      total_cached_read   = total_cached_read + $cached_read,
      total_cached_write  = total_cached_write + $cached_write,
      total_reasoning     = total_reasoning + $reasoning,
      est_cost_usd        = CASE WHEN $cost IS NOT NULL THEN COALESCE(est_cost_usd, 0) + $cost ELSE est_cost_usd END
    WHERE session_id = $session_id
  `);

  const stmtInsertToolCall = db.prepare(`
    INSERT INTO tool_calls
      (session_id, turn_idx, tool_name, skill_name, tool_call_id, spawned_session_id,
       args_size_bytes, result_size_bytes, duration_ms, status, error_message, created_at)
    VALUES
      ($session_id, $turn_idx, $tool_name, $skill_name, $tool_call_id, $spawned_session_id,
       $args_size_bytes, $result_size_bytes, $duration_ms, $status, $error_message, $created_at)
  `);

  const stmtIncrementToolCalls = db.prepare(`
    UPDATE sessions SET total_tool_calls = total_tool_calls + 1 WHERE session_id = $session_id
  `);

  const stmtFinalizeSessionSimple = db.prepare(`
    UPDATE sessions SET
      ended_at            = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      total_input_tokens  = COALESCE((SELECT SUM(COALESCE(input_tokens, 0))        FROM turns WHERE session_id = $session_id), 0),
      total_output_tokens = COALESCE((SELECT SUM(COALESCE(output_tokens, 0))       FROM turns WHERE session_id = $session_id), 0),
      total_cached_read   = COALESCE((SELECT SUM(COALESCE(cached_read_tokens, 0))  FROM turns WHERE session_id = $session_id), 0),
      total_cached_write  = COALESCE((SELECT SUM(COALESCE(cached_write_tokens, 0)) FROM turns WHERE session_id = $session_id), 0),
      total_reasoning     = COALESCE((SELECT SUM(COALESCE(reasoning_tokens, 0))    FROM turns WHERE session_id = $session_id), 0),
      total_turns         = COALESCE((SELECT COUNT(*)                              FROM turns WHERE session_id = $session_id), 0),
      total_tool_calls    = COALESCE((SELECT COUNT(*)                              FROM tool_calls WHERE session_id = $session_id), 0)
    WHERE session_id = $session_id
  `);

  const stmtGetMaxTurnIdx = db.prepare(`
    SELECT COALESCE(MAX(turn_idx), -1) AS max_idx FROM turns WHERE session_id = $session_id
  `);

  const stmtLinkOrphanToolCalls = db.prepare(`
    UPDATE tool_calls
    SET turn_idx = $turn_idx
    WHERE session_id = $session_id
      AND turn_idx IS NULL
      AND created_at >= $window_start
      AND created_at <= $window_end
  `);

  const stmtUpdatePrimaryAgent = db.prepare(`
    UPDATE sessions SET
      primary_agent = $agent,
      slash_command = '/' || $agent
    WHERE session_id = $session_id AND primary_agent IS NULL
  `);

  const stmtRollupPrimaryAgent = db.prepare(`
    UPDATE sessions SET primary_agent = (
      SELECT agent FROM turns
      WHERE session_id = $session_id AND agent IS NOT NULL
      GROUP BY agent ORDER BY COUNT(*) DESC LIMIT 1
    )
    WHERE session_id = $session_id AND primary_agent IS NULL
  `);

  const stmtDeriveSlashCommand = db.prepare(`
    UPDATE sessions
    SET slash_command = '/' || primary_agent
    WHERE session_id = $session_id
      AND primary_agent IS NOT NULL
      AND (slash_command IS NULL OR slash_command = '')
  `);

  return {
    upsertSession(fields) {
      try {
        stmtUpsertSession.run({
          $session_id: fields.session_id,
          $parent_session_id: fields.parent_session_id ?? null,
          $started_at: fields.started_at,
          $primary_agent: fields.primary_agent ?? null,
          $project_path: fields.project_path ?? null,
          $worktree_path: fields.worktree_path ?? null,
          $server_url: fields.server_url ?? null,
        });
      } catch (err) {
        console.warn("[opencode-telemetry] upsertSession failed:", err);
      }
    },

    updatePrimaryAgent(session_id, agent) {
      try {
        stmtUpdatePrimaryAgent.run({ $session_id: session_id, $agent: agent });
      } catch (err) {
        console.warn("[opencode-telemetry] updatePrimaryAgent failed:", err);
      }
    },

    insertTurn(row) {
      try {
        stmtInsertTurn.run({
          $session_id: row.session_id,
          $turn_idx: row.turn_idx,
          $message_id: row.message_id,
          $parent_tool_call_id: row.parent_tool_call_id ?? null,
          $agent: row.agent,
          $model: row.model,
          $provider_id: row.provider_id,
          $thinking_level: row.thinking_level,
          $input_tokens: row.input_tokens,
          $output_tokens: row.output_tokens,
          $cached_read_tokens: row.cached_read_tokens,
          $cached_write_tokens: row.cached_write_tokens,
          $reasoning_tokens: row.reasoning_tokens,
          $latency_ms: row.latency_ms,
          $finish_reason: row.finish_reason,
          $created_at: row.created_at,
        });
      } catch (err) {
        console.warn("[opencode-telemetry] insertTurn failed:", err);
      }
    },

    incrementSessionTurns(session_id, cost, input, output, cached_read, cached_write, reasoning) {
      try {
        stmtIncrementSessionTurns.run({
          $session_id: session_id,
          $cost: cost,
          $input: input,
          $output: output,
          $cached_read: cached_read,
          $cached_write: cached_write,
          $reasoning: reasoning,
        });
      } catch (err) {
        console.warn("[opencode-telemetry] incrementSessionTurns failed:", err);
      }
    },

    insertToolCall(row) {
      try {
        stmtInsertToolCall.run({
          $session_id: row.session_id,
          $turn_idx: row.turn_idx,
          $tool_name: row.tool_name,
          $skill_name: row.skill_name,
          $tool_call_id: row.tool_call_id ?? null,
          $spawned_session_id: row.spawned_session_id ?? null,
          $args_size_bytes: row.args_size_bytes,
          $result_size_bytes: row.result_size_bytes,
          $duration_ms: row.duration_ms,
          $status: row.status,
          $error_message: row.error_message,
          $created_at: row.created_at,
        });
      } catch (err) {
        console.warn("[opencode-telemetry] insertToolCall failed:", err);
      }
    },

    incrementSessionToolCalls(session_id) {
      try {
        stmtIncrementToolCalls.run({ $session_id: session_id });
      } catch (err) {
        console.warn("[opencode-telemetry] incrementSessionToolCalls failed:", err);
      }
    },

    finalizeSession(session_id) {
      try {
        stmtFinalizeSessionSimple.run({ $session_id: session_id });
        stmtRollupPrimaryAgent.run({ $session_id: session_id });
        stmtDeriveSlashCommand.run({ $session_id: session_id });
      } catch (err) {
        console.warn("[opencode-telemetry] finalizeSession failed:", err);
      }
    },

    getMaxTurnIdx(session_id) {
      try {
        const row = stmtGetMaxTurnIdx.get({ $session_id: session_id }) as { max_idx: number } | null;
        return row?.max_idx ?? -1;
      } catch {
        return -1;
      }
    },

    linkOrphanToolCalls(session_id, turn_idx, window_start, window_end) {
      try {
        stmtLinkOrphanToolCalls.run({
          $session_id: session_id,
          $turn_idx: turn_idx,
          $window_start: window_start,
          $window_end: window_end,
        });
      } catch (err) {
        console.warn("[opencode-telemetry] linkOrphanToolCalls failed:", err);
      }
    },

    schemaVersion() {
      try {
        const row = db.query("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string } | null;
        return row ? parseInt(row.value, 10) : 1;
      } catch {
        return 1;
      }
    },

    getServerUrl() {
      try {
        const row = db.query(
          "SELECT server_url FROM sessions WHERE server_url IS NOT NULL ORDER BY started_at DESC LIMIT 1"
        ).get() as { server_url: string } | null;
        return row?.server_url ?? null;
      } catch {
        return null;
      }
    },

    close() {
      try { db.close(); } catch { /* ignore */ }
    },
  };
}
