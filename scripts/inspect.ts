#!/usr/bin/env bun
// Shows a detailed breakdown of a single session.
// Usage: bun run scripts/inspect.ts <session_id>
import { openDatabase } from "./db-compat.ts";
import { getDbPath } from "../src/paths.ts";
import { fetchSessionMessages } from "../src/sdk-bridge.ts";
import { analyzeComposition } from "../src/analyzer/composition.ts";
import { weightedDistribution } from "../src/analyzer/distribution.ts";
import type { TurnDistributionInput } from "../src/analyzer/distribution.ts";
import type { MessageContent } from "../src/sdk-bridge.ts";
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

// Read server URL from the most recent session that has one recorded
const serverUrlRows = db.query(
  "SELECT server_url FROM sessions WHERE server_url IS NOT NULL ORDER BY started_at DESC LIMIT 1"
).all() as { server_url: string }[];
const serverUrlRow = serverUrlRows[0] ?? null;
const serverUrl = serverUrlRow?.server_url ?? process.env.OPENCODE_SERVER_URL ?? null;

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
console.log(`| Est. Cost (self) | ${fmtCost(s.est_cost_usd as number)} |`);

// Compute recursive children cost via CTE
const costRollup = q(`
  WITH RECURSIVE tree(session_id, est_cost_usd) AS (
    SELECT session_id, COALESCE(est_cost_usd, 0) FROM sessions WHERE session_id = $id
    UNION ALL
    SELECT s.session_id, COALESCE(s.est_cost_usd, 0)
    FROM sessions s JOIN tree t ON s.parent_session_id = t.session_id
  )
  SELECT
    ROUND(SUM(est_cost_usd) - (SELECT COALESCE(est_cost_usd, 0) FROM sessions WHERE session_id = $id), 5) AS children_cost,
    ROUND(SUM(est_cost_usd), 5) AS total_cost,
    COUNT(*) - 1 AS children_count
  FROM tree
`, { $id: resolvedId })[0] as Record<string, unknown>;

if ((costRollup?.children_count as number) > 0) {
  console.log(`| Est. Cost (children) | ${fmtCost(costRollup.children_cost as number)} |`);
  console.log(`| Est. Cost (total) | ${fmtCost(costRollup.total_cost as number)} |`);
  console.log(`| Child Sessions | ${costRollup.children_count} |`);
}
console.log();

// Fetch session messages once — reused for Token Distribution and per-turn composition columns.
// Non-fatal: if the opencode server is not running, we degrade gracefully.
let sessionMessages: MessageContent[] = [];
try {
  sessionMessages = await fetchSessionMessages(resolvedId, serverUrl);
} catch { /* non-fatal */ }

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

// ── Token Distribution ───────────────────────────────────────────────────────────────────────────────

console.log(`## Token Distribution\n`);

if (sessionMessages.length === 0) {
  console.log(`_No content data. Run \`octm inspect ${resolvedId} --content\` to populate the cache._\n`);
} else {
  // Aggregate distribution for the whole session
  const sessionContextTokens = ((s.total_input_tokens as number) ?? 0) + ((s.total_cached_read as number) ?? 0);
  const comp = analyzeComposition(sessionMessages, sessionContextTokens);
  const dist = weightedDistribution([{ composition: comp, total_input_tokens: sessionContextTokens }]);

  console.log(`| Component | Share |`);
  console.log(`|-----------|-------|`);
  console.log(`| System / Tool Defs | ${dist.system_prompt}% |`);
  console.log(`| Conversation History | ${dist.conversation_history}% |`);
  console.log(`| Tool Results | ${dist.tool_outputs}% |`);
  console.log(`| Current Turn Input | ${dist.user_message}% |`);
  console.log();
}

// ── Token trajectory ──────────────────────────────────────────────────────────────────────────────────

const turns = q(`
  SELECT turn_idx, agent, model, input_tokens, output_tokens,
         cached_read_tokens, cached_write_tokens, reasoning_tokens, latency_ms, finish_reason, created_at
  FROM turns WHERE session_id = $id ORDER BY turn_idx
`, { $id: resolvedId }) as Record<string, unknown>[];

if (turns.length > 0) {
  console.log(`## Token Trajectory (cached read per turn)\n`);
  const contextValues = turns.map(t => ((t.input_tokens as number) ?? 0) + ((t.cached_read_tokens as number) ?? 0));
  const maxCtx = Math.max(...contextValues, 1);
  const blocks = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const v = contextValues[i];
    const ratio = v / maxCtx;
    const block = ratio === 0 ? "▏" : blocks[Math.min(Math.floor(ratio * blocks.length), blocks.length - 1)];
    const prevV = i > 0 ? contextValues[i - 1] : v;
    const delta = i > 0 && prevV > 0 ? ((v - prevV) / prevV * 100).toFixed(0) : null;
    const deltaStr = delta !== null && Math.abs(Number(delta)) >= 10 ? `  ← +${delta}%` : "";
    console.log(`turn ${String(t.turn_idx).padStart(3)}: ${block.repeat(Math.max(1, Math.round(ratio * 8)))} ${fmtNum(v)}${deltaStr}`);
  }
  console.log();
}

// ── Top deltas ────────────────────────────────────────────────────────────────────────────────────────

if (turns.length > 1) {
  const contextValues = turns.map(t => ((t.input_tokens as number) ?? 0) + ((t.cached_read_tokens as number) ?? 0));
  const deltas: Array<{ turn_idx: number; delta: number; delta_pct: number }> = [];
  for (let i = 1; i < turns.length; i++) {
    const prev = contextValues[i - 1];
    const curr = contextValues[i];
    const d = curr - prev;
    deltas.push({ turn_idx: turns[i].turn_idx as number, delta: d, delta_pct: prev > 0 ? d / prev * 100 : 0 });
  }
  const topDeltas = [...deltas].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);

  console.log(`## Top Turn Deltas\n`);
  console.log("| Turn | Δ tokens | Δ % |");
  console.log("|------|----------|-----|");
  for (const d of topDeltas) {
    const sign = d.delta >= 0 ? "+" : "";
    console.log(`| ${d.turn_idx} | ${sign}${fmtNum(d.delta)} | ${sign}${d.delta_pct.toFixed(1)}% |`);
  }
  console.log();
}

// ── Per-turn metrics ──────────────────────────────────────────────────────────────────────────────────

// Pre-compute per-turn compositions if session messages are available
const userAssistantMsgs = sessionMessages.filter(m => m.role === "user" || m.role === "assistant");
const turnCompositions: Map<number, { sys: number; hist: number; tools: number; inp: number }> = new Map();

if (userAssistantMsgs.length > 0) {
  for (let i = 0; i < turns.length; i++) {
    const turnIdx = turns[i].turn_idx as number;
    // Context for turn i = messages[0..2i] (2i+1 messages: i user+assistant pairs + current user)
    const sliceEnd = Math.min(2 * i + 1, userAssistantMsgs.length);
    const slice = userAssistantMsgs.slice(0, sliceEnd);
    if (slice.length === 0) continue;

    const contextTokens = ((turns[i].input_tokens as number) ?? 0) + ((turns[i].cached_read_tokens as number) ?? 0);
    const comp = analyzeComposition(slice, contextTokens);
    const bp = comp.breakdown_pct;
    const ctxSum = bp.system_prompt + bp.conversation_history + bp.tool_outputs + bp.user_message;
    if (ctxSum === 0) continue;

    turnCompositions.set(turnIdx, {
      sys:   Math.round(bp.system_prompt        / ctxSum * 1000) / 10,
      hist:  Math.round(bp.conversation_history  / ctxSum * 1000) / 10,
      tools: Math.round(bp.tool_outputs          / ctxSum * 1000) / 10,
      inp:   Math.round(bp.user_message          / ctxSum * 1000) / 10,
    });
  }
}

const hasComposition = turnCompositions.size > 0;

console.log(`## Turns\n`);
if (turns.length === 0) {
  console.log("_No turns recorded._\n");
} else {
  if (hasComposition) {
    console.log("| # | Agent | Model | In | Out | Cached | Δ% | Reasoning | Latency | Finish | Sys% | Hist% | Tools% | In% |");
    console.log("|---|-------|-------|-----|-----|--------|----|-----------|---------|--------|------|-------|--------|-----|");
  } else {
    console.log("| # | Agent | Model | In | Out | Cached | Δ% | Reasoning | Latency | Finish |");
    console.log("|---|-------|-------|-----|-----|--------|----|-----------|---------|--------|");
  }
  const contextValues2 = turns.map(t => ((t.input_tokens as number) ?? 0) + ((t.cached_read_tokens as number) ?? 0));
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const prev = i > 0 ? contextValues2[i - 1] : null;
    const curr = contextValues2[i];
    const deltaPct = prev != null && prev > 0 ? `${((curr - prev) / prev * 100).toFixed(1)}%` : "—";

    if (hasComposition) {
      const cp = turnCompositions.get(t.turn_idx as number);
      const sys   = cp ? `${cp.sys}%`   : "—";
      const hist  = cp ? `${cp.hist}%`  : "—";
      const tools = cp ? `${cp.tools}%` : "—";
      const inp   = cp ? `${cp.inp}%`   : "—";
      console.log(
        `| ${t.turn_idx} | ${t.agent ?? "—"} | ${t.model ?? "—"} | ${fmtNum(t.input_tokens as number)} | ${fmtNum(t.output_tokens as number)} | ${fmtNum(t.cached_read_tokens as number)} | ${deltaPct} | ${fmtNum(t.reasoning_tokens as number)} | ${fmtMs(t.latency_ms as number)} | ${t.finish_reason ?? "—"} | ${sys} | ${hist} | ${tools} | ${inp} |`
      );
    } else {
      console.log(
        `| ${t.turn_idx} | ${t.agent ?? "—"} | ${t.model ?? "—"} | ${fmtNum(t.input_tokens as number)} | ${fmtNum(t.output_tokens as number)} | ${fmtNum(t.cached_read_tokens as number)} | ${deltaPct} | ${fmtNum(t.reasoning_tokens as number)} | ${fmtMs(t.latency_ms as number)} | ${t.finish_reason ?? "—"} |`
      );
    }
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

// ── Cache efficiency ────────────────────────────────────────────────────────────────────────────────────

import pricingData from "../src/pricing.json" with { type: "json" };
type PricingEntry = { input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok: number; cache_write_per_mtok: number };
const pricing = pricingData as Record<string, PricingEntry | string>;

console.log(`## Cache Efficiency\n`);
const cacheRows = q(`
  SELECT
    COALESCE(provider_id, '—') AS provider,
    COALESCE(model, '—') AS model,
    SUM(COALESCE(cached_read_tokens, 0)) AS cache_read,
    SUM(COALESCE(cached_write_tokens, 0)) AS cache_write,
    SUM(COALESCE(input_tokens, 0)) AS fresh_input,
    ROUND(100.0 * SUM(COALESCE(cached_read_tokens, 0)) /
      NULLIF(SUM(COALESCE(cached_read_tokens, 0) + COALESCE(input_tokens, 0)), 0), 1) AS hit_pct
  FROM turns
  WHERE session_id = $id
  GROUP BY provider_id, model
  ORDER BY hit_pct DESC
`, { $id: resolvedId }) as Record<string, unknown>[];

if (cacheRows.length === 0) {
  console.log("_No cache data for this session._\n");
} else {
  console.log("| Provider | Model | Cache Reads | Cache Writes | Fresh Input | Hit % | Savings vs No-Cache |");
  console.log("|----------|-------|-------------|--------------|-------------|-------|---------------------|");
  for (const r of cacheRows) {
    const key = `${r.provider}/${r.model}`;
    const entry = pricing[key];
    let savings = "N/A";
    if (entry && typeof entry !== "string") {
      const saved = ((r.cache_read as number) * (entry.input_per_mtok - entry.cache_read_per_mtok)) / 1_000_000;
      savings = `$${saved.toFixed(5)}`;
    }
    console.log(`| ${r.provider} | ${r.model} | ${fmtNum(r.cache_read as number)} | ${fmtNum(r.cache_write as number)} | ${fmtNum(r.fresh_input as number)} | ${r.hit_pct ?? "—"}% | ${savings} |`);
  }
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
