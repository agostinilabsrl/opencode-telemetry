import { initDatabase } from "../src/db.ts";

const db = initDatabase();
console.log("DB initialized OK");

db.upsertSession({
  session_id: "smoke-test-001",
  started_at: new Date().toISOString(),
  project_path: "/tmp/test",
});

db.insertTurn({
  session_id: "smoke-test-001",
  turn_idx: 0,
  message_id: "msg-1",
  parent_tool_call_id: null,
  agent: "claude-sonnet-4-6",
  model: "claude-sonnet-4-6",
  provider_id: "anthropic",
  thinking_level: null,
  input_tokens: 100,
  output_tokens: 50,
  cached_read_tokens: 200,
  cached_write_tokens: 300,
  reasoning_tokens: null,
  latency_ms: 1200,
  finish_reason: "stop",
  created_at: new Date().toISOString(),
});

db.incrementSessionTurns("smoke-test-001", 0.0015, 100, 50, 200, 300, 0);

db.insertToolCall({
  session_id: "smoke-test-001",
  turn_idx: 0,
  tool_name: "bash",
  skill_name: null,
  tool_call_id: "call-smoke-1",
  spawned_session_id: null,
  args_size_bytes: 42,
  result_size_bytes: 200,
  duration_ms: 300,
  status: "ok",
  error_message: null,
  created_at: new Date().toISOString(),
});

db.incrementSessionToolCalls("smoke-test-001");
db.finalizeSession("smoke-test-001");

console.log("All writes OK. Check DB at:", process.env.XDG_DATA_HOME
  ? `${process.env.XDG_DATA_HOME}/opencode-telemetry/data.db`
  : `~/.local/share/opencode-telemetry/data.db`);

// ── Parent-child attribution verification ─────────────────────────────────────
// Synthetic test: insert a parent session and a child session that references it,
// then query the child back to confirm attribution round-trips correctly.

db.upsertSession({
  session_id: "smoke-parent-001",
  started_at: new Date().toISOString(),
  project_path: "/tmp/test",
});

db.upsertSession({
  session_id: "smoke-child-001",
  parent_session_id: "smoke-parent-001",
  started_at: new Date().toISOString(),
  project_path: "/tmp/test",
  primary_agent: "act",
});

db.insertTurn({
  session_id: "smoke-parent-001",
  turn_idx: 0,
  message_id: "msg-parent-1",
  parent_tool_call_id: null,
  agent: "conductor",
  model: "claude-sonnet-4-6",
  provider_id: "anthropic",
  thinking_level: null,
  input_tokens: 500,
  output_tokens: 100,
  cached_read_tokens: 0,
  cached_write_tokens: 0,
  reasoning_tokens: null,
  latency_ms: 800,
  finish_reason: "stop",
  created_at: new Date().toISOString(),
});

db.insertTurn({
  session_id: "smoke-child-001",
  turn_idx: 0,
  message_id: "msg-child-1",
  parent_tool_call_id: null,
  agent: "act",
  model: "claude-sonnet-4-6",
  provider_id: "anthropic",
  thinking_level: null,
  input_tokens: 2000,
  output_tokens: 300,
  cached_read_tokens: 1500,
  cached_write_tokens: 0,
  reasoning_tokens: null,
  latency_ms: 2100,
  finish_reason: "stop",
  created_at: new Date().toISOString(),
});

db.incrementSessionTurns("smoke-parent-001", 0.0004, 500, 100, 0, 0, 0);
db.incrementSessionTurns("smoke-child-001", 0.0025, 2000, 300, 1500, 0, 0);
db.finalizeSession("smoke-parent-001");
db.finalizeSession("smoke-child-001");

// Query the child back by parent_session_id to verify attribution
import { Database } from "bun:sqlite";
import { getDbPath } from "../src/paths.ts";
const verifyDb = new Database(getDbPath(), { readonly: true });
const rows = verifyDb.query(
  "SELECT session_id, parent_session_id FROM sessions WHERE parent_session_id = $id"
).all({ $id: "smoke-parent-001" }) as { session_id: string; parent_session_id: string }[];
verifyDb.close();

if (rows.length !== 1 || rows[0].session_id !== "smoke-child-001") {
  throw new Error(
    `FAIL: parent-child attribution broken — expected 1 child row with session_id='smoke-child-001', got: ${JSON.stringify(rows)}`
  );
}

console.log("PASS: parent-child attribution OK (smoke-parent-001 → smoke-child-001)");

db.close();
