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

db.close();
