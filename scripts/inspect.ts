#!/usr/bin/env bun
// Shows a detailed breakdown of a single session.
// Usage: bun run scripts/inspect.ts <session_id>
import { openDatabase } from "./db-compat.ts";
import { getDbPath } from "../src/paths.ts";
import fs from "fs";

const sessionId = process.argv[2];
if (!sessionId) {
  console.error("Usage: bun run scripts/inspect.ts <session_id>");
  process.exit(1);
}

const dbPath = getDbPath();
if (!fs.existsSync(dbPath)) {
  console.log("No telemetry database found. Run a session with opencode-telemetry installed first.");
  process.exit(1);
}

const db = openDatabase(dbPath);

type Bindings = Record<string, string | number | boolean | null | bigint | Uint8Array>;
function q(sql: string, params: Bindings = {}): unknown[] {
  return db.query(sql).all(params) as unknown[];
}

function fmtCost(v: number | null | undefined): string {
  if (v == null) return "—";
  return `$${Number(v).toFixed(5)}`;
}

function fmtNum(v: number | null | undefined): string {
  if (v == null) return "—";
  return Number(v).toLocaleString();
}

function fmtMs(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

// ── Session metadata ──────────────────────────────────────────────────────────────────────────────────

const sessions = q(`SELECT * FROM sessions WHERE session_id = $id`, { $id: sessionId });
if (sessions.length === 0) {
  // Try prefix match for convenience (allow short IDs)
  const prefixMatches = q(
    `SELECT * FROM sessions WHERE session_id LIKE $prefix ORDER BY started_at DESC LIMIT 1`,
    { $prefix: `${sessionId}%` }
  );
  if (prefixMatches.length === 0) {
    console.log(`No session found with ID (or prefix): ${sessionId}`);
    process.exit(1);
  }
  sessions.push(prefixMatches[0]);
}
const s = sessions[0] as Record<string, unknown>;
const resolvedId = s.session_id as string;

const slashCmd = (s.slash_command as string | null) ??
  (s.primary_agent ? `/${s.primary_agent}` : null);

console.log(`# Session Inspect: ${resolvedId}\n`);
console.log(`| Field | Value |`);
console.log(`|-------|-------|`);
console.log(`| Started | ${s.started_at ?? "—"} |`);
console.log(`| Ended | ${s.ended_at ?? "still active"} |`);
console.log(`| Slash Command / Entrypoint | ${slashCmd ?? "—"} |`);
console.log(`| Primary Agent | ${s.primary_agent ?? "—"} |`);
console.log(`| Project | ${s.project_path ?? "—"} |`);
console.log(`| Worktree | ${s.worktree_path ?? "—"} |`);
console.log(`| Parent Session | ${s.parent_session_id ?? "none"} |`);
console.log(`| Total Turns | ${s.total_turns} |`);
console.log(`| Total Tool Calls | ${s.total_tool_calls} |`);
console.log(`| Input Tokens | ${fmtNum(s.total_input_tokens as number)} |`);
console.log(`| Output Tokens | ${fmtNum(s.total_output_tokens as number)} |`);
console.log(`| Cached Read | ${fmtNum(s.total_cached_read as number)} |`);
console.log(`| Cached Write | ${fmtNum(s.total_cached_write as number)} |`);
console.log(`| Reasoning Tokens | ${fmtNum(s.total_reasoning as number)} |`);
console.log(`| Est. Cost | ${fmtCost(s.est_cost_usd as number)} |`);
console.log();

// ── Sub-sessions (agent hops) ─────────────────────────────────────────────────────────────────────────

const subSessions = q(`
  SELECT session_id, primary_agent, slash_command, started_at, ended_at,
    total_turns, total_input_tokens, total_output_tokens, total_cached_read, est_cost_usd
  FROM sessions
  WHERE parent_session_id = $id
  ORDER BY started_at
`, { $id: resolvedId }) as Record<string, unknown>[];

if (subSessions.length > 0) {
  console.log(`## Agent Hops (Sub-Sessions)\n`);
  console.log(`| Sub-Session ID | Agent | Started | Ended | Turns | Input Tok | Output Tok | Cache Read | Est. Cost |`);
  console.log(`|----------------|-------|---------|-------|-------|-----------|------------|------------|-----------|`);
  for (const sub of subSessions) {
    const subCmd = (sub.slash_command as string | null) ?? (sub.primary_agent ? `/${sub.primary_agent}` : "—");
    console.log(`| ${sub.session_id} | ${subCmd} | ${String(sub.started_at).slice(11, 19)} | ${sub.ended_at ? String(sub.ended_at).slice(11, 19) : "active"} | ${sub.total_turns} | ${fmtNum(sub.total_input_tokens as number)} | ${fmtNum(sub.total_output_tokens as number)} | ${fmtNum(sub.total_cached_read as number)} | ${fmtCost(sub.est_cost_usd as number)} |`);
  }
  console.log();
}

// ── Agent chain within this session ──────────────────────────────────────────────────────────────────

console.log(`## Agent Chain\n`);
const agentChain = q(`
  SELECT
    COALESCE(agent, '—') AS agent,
    COUNT(*) AS turns,
    SUM(input_tokens + COALESCE(cached_read_tokens, 0)) AS total_in,
    SUM(output_tokens) AS total_out,
    SUM(COALESCE(cached_read_tokens, 0)) AS cache_read,
    ROUND(100.0 * SUM(COALESCE(cached_read_tokens, 0)) /
      NULLIF(SUM(COALESCE(cached_read_tokens, 0) + COALESCE(input_tokens, 0)), 0), 1) AS cache_hit_pct,
    MIN(created_at) AS first_turn,
    MAX(created_at) AS last_turn
  FROM turns
  WHERE session_id = $id
  GROUP BY agent
  ORDER BY first_turn
`, { $id: resolvedId }) as Record<string, unknown>[];

if (agentChain.length === 0) {
  console.log("_No turn data._\n");
} else {
  console.log("| Agent | Turns | Input Tok | Output Tok | Cache Read | Cache Hit % | First Turn | Last Turn |");
  console.log("|-------|-------|-----------|------------|------------|-------------|------------|-----------|");
  for (const r of agentChain) {
    const cachePct = r.cache_hit_pct != null ? `${r.cache_hit_pct}%` : "—";
    console.log(`| ${r.agent} | ${r.turns} | ${fmtNum(r.total_in as number)} | ${fmtNum(r.total_out as number)} | ${fmtNum(r.cache_read as number)} | ${cachePct} | ${String(r.first_turn).slice(11, 19)} | ${String(r.last_turn).slice(11, 19)} |`);
  }
  console.log();
}

// ── Per-turn metrics ──────────────────────────────────────────────────────────────────────────────────

console.log(`## Turns\n`);
const turns = q(`
  SELECT turn_idx, agent, model, input_tokens, output_tokens,
         cached_read_tokens, reasoning_tokens, latency_ms, finish_reason, created_at
  FROM turns WHERE session_id = $id ORDER BY turn_idx
`, { $id: resolvedId }) as Record<string, unknown>[];

if (turns.length === 0) {
  console.log("_No turns recorded._\n");
} else {
  console.log("| # | Agent | Model | In | Out | Cached | Reasoning | Latency | Finish |");
  console.log("|---|-------|-------|-----|-----|--------|-----------|---------|--------|")
  for (const t of turns) {
    console.log(
      `| ${t.turn_idx} | ${t.agent ?? "—"} | ${t.model ?? "—"} | ${fmtNum(t.input_tokens as number)} | ${fmtNum(t.output_tokens as number)} | ${fmtNum(t.cached_read_tokens as number)} | ${fmtNum(t.reasoning_tokens as number)} | ${fmtMs(t.latency_ms as number)} | ${t.finish_reason ?? "—"} |`
    );
  }
  console.log();
}

// ── Tool call timeline ────────────────────────────────────────────────────────────────────────────────

console.log(`## Tool Call Timeline\n`);
const tools = q(`
  SELECT tool_name, skill_name, args_size_bytes, result_size_bytes,
         duration_ms, status, error_message, created_at
  FROM tool_calls WHERE session_id = $id ORDER BY created_at
`, { $id: resolvedId }) as Record<string, unknown>[];

if (tools.length === 0) {
  console.log("_No tool calls recorded._\n");
} else {
  console.log("| Tool | Args (B) | Result (B) | Duration | Status | Time |");
  console.log("|------|----------|-----------|----------|--------|------|")
  for (const t of tools) {
    const label = t.skill_name ? `skill:${t.skill_name}` : String(t.tool_name);
    console.log(
      `| ${label} | ${fmtNum(t.args_size_bytes as number)} | ${fmtNum(t.result_size_bytes as number)} | ${fmtMs(t.duration_ms as number)} | ${t.status} | ${String(t.created_at).slice(11, 19)} |`
    );
    if (t.error_message) {
      console.log(`  > **Error**: ${t.error_message}`);
    }
  }
  console.log();
}

// ── Tool result size stats per tool type ──────────────────────────────────────────────────────────────

console.log(`## Tool Result Size Stats\n`);
const toolStatRows = q(`
  SELECT
    tool_name,
    COUNT(*) AS calls,
    CAST(AVG(result_size_bytes) AS INTEGER) AS avg_bytes,
    MAX(result_size_bytes) AS max_bytes,
    MIN(result_size_bytes) AS min_bytes
  FROM tool_calls
  WHERE session_id = $id AND result_size_bytes IS NOT NULL
  GROUP BY tool_name
  ORDER BY avg_bytes DESC
`, { $id: resolvedId }) as Record<string, unknown>[];

if (toolStatRows.length === 0) {
  console.log("_No tool result data._\n");
} else {
  console.log("| Tool | Calls | Avg (B) | Min (B) | Max (B) |");
  console.log("|------|-------|---------|---------|---------|");
  for (const r of toolStatRows) {
    console.log(`| ${r.tool_name} | ${r.calls} | ${fmtNum(r.avg_bytes as number)} | ${fmtNum(r.min_bytes as number)} | ${fmtNum(r.max_bytes as number)} |`);
  }
  console.log();
}

// ── Skill usage summary ─────────────────────────────────────────────────────────────────────────────────

console.log(`## Skill Usage\n`);
const skillSummary = q(`
  SELECT skill_name, COUNT(*) AS calls, SUM(result_size_bytes) AS total_bytes
  FROM tool_calls
  WHERE session_id = $id AND tool_name = 'skill' AND skill_name IS NOT NULL
  GROUP BY skill_name
  ORDER BY calls DESC
`, { $id: resolvedId }) as Record<string, unknown>[];

if (skillSummary.length === 0) {
  console.log("_No skills loaded in this session._\n");
} else {
  console.log("| Skill | Calls | Total Result Bytes |");
  console.log("|-------|-------|-------------------|")
  for (const r of skillSummary) {
    const dupeFlag = (r.calls as number) > 1 ? " ⚠️ duplicate" : "";
    console.log(`| ${r.skill_name}${dupeFlag} | ${r.calls} | ${fmtNum(r.total_bytes as number)} |`);
  }
  console.log();
}

// ── Cost breakdown ─────────────────────────────────────────────────────────────────────────────────────

const totalCost = (s.est_cost_usd as number | null) ?? null;
console.log(`## Cost Breakdown\n`);
if (totalCost == null) {
  console.log("_Cost not estimated (model not in pricing.json)._\n");
} else {
  const totalIn = (s.total_input_tokens as number) ?? 0;
  const totalOut = (s.total_output_tokens as number) ?? 0;
  const totalCR = (s.total_cached_read as number) ?? 0;
  const totalCW = (s.total_cached_write as number) ?? 0;
  console.log(`| Component | Tokens | Notes |`);
  console.log(`|-----------|--------|-------|`);
  console.log(`| Input (fresh) | ${fmtNum(totalIn)} | Billed at input rate |`);
  console.log(`| Output | ${fmtNum(totalOut)} | Billed at output rate |`);
  console.log(`| Cache read | ${fmtNum(totalCR)} | ~10% of input rate |`);
  console.log(`| Cache write | ${fmtNum(totalCW)} | ~125% of input rate |`);
  console.log(`| **Total** | | **${fmtCost(totalCost)}** |`);
  console.log();
}

db.close();

// ── Disclaimer ────────────────────────────────────────────────────────────────────────────────────────

console.log(`---`);
console.log();
console.log(`> **Advanced analysis available** — Use the \`/telemetry-db-analyst\` skill to query the`);
console.log(`> telemetry database directly with natural-language questions. The skill gives opencode`);
console.log(`> full SQL access to \`sessions\`, \`turns\`, and \`tool_calls\` for custom breakdowns,`);
console.log(`> context source analysis, inter-hop comparisons, and queries not shown above.`);
