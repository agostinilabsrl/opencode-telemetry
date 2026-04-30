export interface SessionRow {
  session_id: string;
  parent_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  primary_agent: string | null;
  slash_command: string | null;
  project_path: string | null;
  worktree_path: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_read: number;
  total_cached_write: number;
  total_reasoning: number;
  total_turns: number;
  total_tool_calls: number;
  est_cost_usd: number | null;
}

export interface TurnRow {
  session_id: string;
  turn_idx: number;
  message_id: string | null;
  agent: string | null;
  model: string | null;
  provider_id: string | null;
  thinking_level: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_read_tokens: number | null;
  cached_write_tokens: number | null;
  reasoning_tokens: number | null;
  latency_ms: number | null;
  finish_reason: string | null;
  created_at: string;
}

export interface ToolCallRow {
  session_id: string;
  turn_idx: number | null;
  tool_name: string;
  skill_name: string | null;
  args_size_bytes: number | null;
  result_size_bytes: number | null;
  duration_ms: number | null;
  status: "ok" | "error" | "timeout";
  error_message: string | null;
  created_at: string;
}

export interface PendingToolCall {
  session_id: string;
  turn_idx: number | null;
  tool_name: string;
  skill_name: string | null;
  args_size_bytes: number | null;
  start_time: number;
  created_at: string;
}

// Minimal shapes of opencode event payloads (verified fields only — rest stored NULL).
// TODO: These were inferred from spec §10 and must be validated against live payloads.

export interface MessageUsage {
  // Anthropic field names
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  // OpenAI field names
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
}

export interface MessageMetadata {
  model?: string;
  provider?: string;
  provider_id?: string;
  agent?: string;
  finishReason?: string;
  finish_reason?: string;
  thinking_level?: string;
  // May surface as reasoning_tokens > 0
}

export interface PluginMessage {
  id?: string;
  role?: string;
  usage?: MessageUsage;
  metadata?: MessageMetadata;
  // Some fields may be top-level depending on opencode version
  model?: string;
  provider?: string;
  provider_id?: string;
  agent?: string;
  finishReason?: string;
  finish_reason?: string;
  thinking_level?: string;
}
