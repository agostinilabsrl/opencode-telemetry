#!/usr/bin/env bun
// Generates a markdown telemetry report for the last N days (default 7).
import { openDatabase } from "./db-compat.ts";
import { getDbPath } from "../src/paths.ts";
import fs from "fs";
import { fetchSessionMessages } from "../src/sdk-bridge.ts";
import { analyzeComposition } from "../src/analyzer/composition.ts";
import { weightedDistribution } from "../src/analyzer/distribution.ts";
import type { TurnDistributionInput } from "../src/analyzer/distribution.ts";

const dbPath = getDbPath();
if (!fs.existsSync(dbPath)) {
  console.log("# Telemetry Report\n\nNo data yet. Run a session with opencode-telemetry installed first.");
  process.exit(0);
}

const db = openDatabase(dbPath);

type Bindings = Record<string, string | number | boolean | null | bigint | Uint8Array>;
function q(sql: string, params: Bindings = {}): unknown[] {
  return db.query(sql).all(params) as unknown[];
}

function fmtCost(v: number | null): string {
  if (v == null) return "—";
  return `$${v.toFixed(4)}`;
}

function fmtNum(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString();
}

let days = 7;
const daysArgIdx = process.argv.indexOf("--days");
if (daysArgIdx !== -1 && process.argv[daysArgIdx + 1]) {
  const n = parseInt(process.argv[daysArgIdx + 1], 10);
  if (!isNaN(n) && n > 0) days = n;
} else if (process.env.OCTM_DAYS) {
  const n = parseInt(process.env.OCTM_DAYS, 10);
  if (!isNaN(n) && n > 0) days = n;
}
const WINDOW = `'-${days} days'`;
const dayLabel = days === 1 ? "Last 1 Day" : `Last ${days} Days`;

// ── Headline ──────────────────────────────────────────────────────────────────────────────

const headline = q(`
  SELECT
    COUNT(DISTINCT s.session_id) AS sessions,
    SUM(s.total_turns) AS turns,
    SUM(s.total_input_tokens + s.total_output_tokens + s.total_cached_read + s.total_cached_write) AS total_tokens,
    SUM(s.est_cost_usd) AS total_cost
  FROM sessions s
  WHERE s.started_at >= datetime('now', ${WINDOW})
`)[0] as Record<string, number | null>;

console.log(`# Telemetry Report — ${dayLabel}\n`);
console.log(`| Metric | Value |`);
console.log(`|--------|-------|`);
console.log(`| Sessions | ${fmtNum(headline?.sessions as number)} |`);
console.log(`| Turns | ${fmtNum(headline?.turns as number)} |`);
console.log(`| Total Tokens | ${fmtNum(headline?.total_tokens as number)} |`);
console.log(`| Est. Cost | ${fmtCost(headline?.total_cost as number)} |`);
console.log();

// ── Token Distribution ────────────────────────────────────────────────────────────────────
console.log(`## Token Distribution\n`);

// Prefer server URL recorded in DB (set at session creation), fall back to env
const serverUrlRows = q(
  "SELECT server_url FROM sessions WHERE server_url IS NOT NULL ORDER BY started_at DESC LIMIT 1"
) as { server_url: string }[];
const serverUrl = serverUrlRows[0]?.server_url ?? process.env.OPENCODE_SERVER_URL ?? null;

// Top 50 sessions by context tokens — caps worst-case latency and covers the vast majority of token weight
const sessionTokenRows = q(`
  SELECT session_id,
    COALESCE(total_input_tokens, 0) + COALESCE(total_cached_read, 0) AS context_tokens
  FROM sessions
  WHERE started_at >= datetime('now', ${WINDOW})
  ORDER BY context_tokens DESC
  LIMIT 50
`) as { session_id: string; context_tokens: number }[];

// Parallel fetch — cache hits are instant; timeouts all fire at once rather than serially
const distInputs: TurnDistributionInput[] = await Promise.all(
  sessionTokenRows.map(async (row) => {
    try {
      const messages = await fetchSessionMessages(row.session_id, serverUrl);
      if (messages.length > 0) {
        const comp = analyzeComposition(messages, row.context_tokens);
        return { composition: comp, total_input_tokens: row.context_tokens };
      }
    } catch { /* non-fatal */ }
    return { composition: null, total_input_tokens: row.context_tokens };
  })
);

const dist = weightedDistribution(distInputs);

if (dist.covered_turns === 0) {
  console.log(`_No content data available. Run \`octm inspect <session_id> --content\` to populate the content cache._\n`);
} else {
  console.log(`_Coverage: ${dist.covered_turns}/${dist.total_turns} sessions (${dist.coverage_pct}% of token weight). Distribution estimated from full session context._\n`);
  console.log(`| Component | Share |`);
  console.log(`|-----------|-------|`);
  console.log(`| System / Tool Defs | ${dist.system_prompt}% |`);
  console.log(`| Conversation History | ${dist.conversation_history}% |`);
  console.log(`| Tool Results | ${dist.tool_outputs}% |`);
  console.log(`| Current Turn Input | ${dist.user_message}% |`);
  console.log();
}

// ── Top 10 sessions by cost ───────────────────────────────────────────────────────────────────────────

console.log(`## Top 10 Sessions by Cost\n`);
const topSessions = q(`
  WITH RECURSIVE tree(session_id, root, est_cost_usd) AS (
    SELECT session_id, session_id AS root, COALESCE(est_cost_usd, 0) FROM sessions
    UNION ALL
    SELECT s.session_id, t.root, COALESCE(s.est_cost_usd, 0)
    FROM sessions s JOIN tree t ON s.parent_session_id = t.session_id
  ),
  rollup AS (
    SELECT
      root,
      ROUND(MAX(CASE WHEN tree.session_id = tree.root THEN tree.est_cost_usd END), 5) AS self_cost,
      ROUND(COALESCE(SUM(CASE WHEN tree.session_id != tree.root THEN tree.est_cost_usd END), 0), 5) AS children_cost,
      ROUND(SUM(tree.est_cost_usd), 5) AS total_cost,
      COUNT(*) - 1 AS children_count
    FROM tree GROUP BY root
  )
  SELECT
    s.session_id AS id,
    COALESCE(s.slash_command, CASE WHEN s.primary_agent IS NOT NULL THEN '/' || s.primary_agent ELSE '—' END) AS command,
    COALESCE(s.primary_agent, '—') AS agent,
    s.total_input_tokens + s.total_output_tokens AS tokens,
    r.self_cost AS cost,
    r.children_cost,
    r.total_cost,
    r.children_count,
    s.total_turns AS turns,
    substr(s.started_at, 1, 16) AS started
  FROM sessions s
  JOIN rollup r ON r.root = s.session_id
  WHERE s.started_at >= datetime('now', ${WINDOW})
    AND s.parent_session_id IS NULL
    AND r.self_cost IS NOT NULL
  ORDER BY r.total_cost DESC
  LIMIT 10
`) as Record<string, unknown>[];

if (topSessions.length === 0) {
  console.log("_No sessions with cost data._\n");
} else {
  console.log("| Session ID | Command | Agent | Tokens | Self Cost | Children | Total Cost | Turns | Started |");
  console.log("|------------|---------|-------|--------|-----------|----------|------------|-------|---------|");
  for (const r of topSessions) {
    const hasChildren = (r.children_count as number) > 0;
    const childrenCost = hasChildren ? fmtCost(r.children_cost as number) + " ▲" : "—";
    console.log(`| ${r.id} | ${r.command} | ${r.agent} | ${fmtNum(r.tokens as number)} | ${fmtCost(r.cost as number)} | ${childrenCost} | ${fmtCost(r.total_cost as number)} | ${r.turns} | ${r.started} |`);
  }
  console.log();
}

// ── Per-agent breakdown ─────────────────────────────────────────────────────────────────────────────

console.log(`## Per-Agent Breakdown\n`);
const perAgent = q(`
  SELECT
    COALESCE(agent, '—') AS agent,
    SUM(input_tokens + COALESCE(cached_read_tokens, 0)) AS total_in,
    SUM(output_tokens) AS total_out,
    ROUND(1.0 * SUM(input_tokens + COALESCE(cached_read_tokens, 0)) / NULLIF(SUM(output_tokens), 0), 1) AS ratio,
    COUNT(*) AS turns,
    ROUND(100.0 * SUM(COALESCE(cached_read_tokens, 0)) /
      NULLIF(SUM(COALESCE(cached_read_tokens, 0) + COALESCE(input_tokens, 0)), 0), 1) AS cache_hit_pct
  FROM turns
  WHERE created_at >= datetime('now', ${WINDOW})
  GROUP BY agent
  ORDER BY total_in DESC
`) as Record<string, unknown>[];

if (perAgent.length === 0) {
  console.log("_No turn data._\n");
} else {
  console.log("| Agent | Total In | Total Out | In/Out | Turns | Cache Hit % |");
  console.log("|-------|----------|-----------|--------|-------|-------------|")
  for (const r of perAgent) {
    const cachePct = r.cache_hit_pct != null ? `${r.cache_hit_pct}%` : "—";
    console.log(`| ${r.agent} | ${fmtNum(r.total_in as number)} | ${fmtNum(r.total_out as number)} | ${r.ratio ?? "—"} | ${r.turns} | ${cachePct} |`);
  }
  console.log();
}

// ── Per-model breakdown ─────────────────────────────────────────────────────────────────────────────

console.log(`## Per-Model Breakdown\n`);
const perModel = q(`
  SELECT
    COALESCE(provider_id, '—') AS provider,
    COALESCE(model, '—') AS model,
    COUNT(*) AS calls,
    SUM(input_tokens + COALESCE(output_tokens, 0) + COALESCE(cached_read_tokens, 0)) AS total_tokens
  FROM turns
  WHERE created_at >= datetime('now', ${WINDOW})
  GROUP BY provider_id, model
  ORDER BY total_tokens DESC
`) as Record<string, unknown>[];

if (perModel.length === 0) {
  console.log("_No turn data._\n");
} else {
  console.log("| Provider | Model | Calls | Total Tokens |");
  console.log("|----------|-------|-------|--------------|")
  for (const r of perModel) {
    console.log(`| ${r.provider} | ${r.model} | ${r.calls} | ${fmtNum(r.total_tokens as number)} |`);
  }
  console.log();
}

// ── Tool result size stats (p50 / p95 per tool type) ──────────────────────────────────────────────────────

console.log(`## Tool Result Size Stats (p50 / p95)\n`);
const toolStats = q(`
  WITH base AS (
    SELECT tool_name, result_size_bytes
    FROM tool_calls
    WHERE result_size_bytes IS NOT NULL
      AND created_at >= datetime('now', ${WINDOW})
  ),
  agg AS (
    SELECT tool_name,
      COUNT(*) AS calls,
      CAST(AVG(result_size_bytes) AS INTEGER) AS avg_bytes,
      MAX(result_size_bytes) AS max_bytes
    FROM base GROUP BY tool_name
  ),
  p50 AS (
    SELECT tool_name, CAST(result_size_bytes AS INTEGER) AS p50_bytes
    FROM (
      SELECT tool_name, result_size_bytes,
        ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY result_size_bytes) AS rn,
        COUNT(*) OVER (PARTITION BY tool_name) AS cnt
      FROM base
    ) WHERE rn = (cnt + 1) / 2
  ),
  p95 AS (
    SELECT tool_name, CAST(result_size_bytes AS INTEGER) AS p95_bytes
    FROM (
      SELECT tool_name, result_size_bytes,
        ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY result_size_bytes) AS rn,
        COUNT(*) OVER (PARTITION BY tool_name) AS cnt
      FROM base
    ) WHERE rn = CASE WHEN CAST(cnt * 0.95 AS INTEGER) < 1 THEN 1
                      ELSE CAST(cnt * 0.95 AS INTEGER) END
  )
  SELECT a.tool_name, a.calls, a.avg_bytes, a.max_bytes,
    COALESCE(p50.p50_bytes, a.avg_bytes) AS p50_bytes,
    COALESCE(p95.p95_bytes, a.avg_bytes) AS p95_bytes
  FROM agg a
  LEFT JOIN p50 ON p50.tool_name = a.tool_name
  LEFT JOIN p95 ON p95.tool_name = a.tool_name
  ORDER BY a.avg_bytes DESC
  LIMIT 20
`) as Record<string, unknown>[];

if (toolStats.length === 0) {
  console.log("_No tool call data._\n");
} else {
  console.log("| Tool | Calls | Avg (B) | p50 (B) | p95 (B) | Max (B) |");
  console.log("|------|-------|---------|---------|---------|---------|")
  for (const r of toolStats) {
    console.log(`| ${r.tool_name} | ${r.calls} | ${fmtNum(r.avg_bytes as number)} | ${fmtNum(r.p50_bytes as number)} | ${fmtNum(r.p95_bytes as number)} | ${fmtNum(r.max_bytes as number)} |`);
  }
  console.log();
}

// ── Skill usage ───────────────────────────────────────────────────────────────────────────────────

console.log(`## Skill Usage\n`);
const skills = q(`
  SELECT
    skill_name,
    SUM(cnt) AS calls,
    COUNT(DISTINCT session_id) AS sessions,
    SUM(CASE WHEN cnt > 1 THEN 1 ELSE 0 END) AS sessions_with_dupes
  FROM (
    SELECT skill_name, session_id, COUNT(*) AS cnt
    FROM tool_calls
    WHERE tool_name = 'skill' AND skill_name IS NOT NULL
      AND created_at >= datetime('now', ${WINDOW})
    GROUP BY skill_name, session_id
  )
  GROUP BY skill_name
  ORDER BY calls DESC
  LIMIT 20
`) as Record<string, unknown>[];

if (skills.length === 0) {
  console.log("_No skill data._\n");
} else {
  console.log("| Skill | Calls | Sessions | Sessions w/ Dupes |");
  console.log("|-------|-------|----------|-------------------|")
  for (const r of skills) {
    console.log(`| ${r.skill_name} | ${r.calls} | ${r.sessions} | ${r.sessions_with_dupes} |`);
  }
  console.log();
}

// ── Largest tool result outputs ───────────────────────────────────────────────────────────────────────────

console.log(`## Largest Tool Result Outputs (top 10)\n`);
const bigResults = q(`
  SELECT
    tool_name,
    skill_name,
    result_size_bytes,
    duration_ms,
    session_id,
    substr(created_at, 1, 16) AS time
  FROM tool_calls
  WHERE result_size_bytes IS NOT NULL
    AND created_at >= datetime('now', ${WINDOW})
  ORDER BY result_size_bytes DESC
  LIMIT 10
`) as Record<string, unknown>[];

if (bigResults.length === 0) {
  console.log("_No tool call data._\n");
} else {
  console.log("| Tool | Result (bytes) | Duration (ms) | Session ID | Time |");
  console.log("|------|----------------|---------------|------------|------|")
  for (const r of bigResults) {
    const toolLabel = r.skill_name ? `${r.tool_name}:${r.skill_name}` : String(r.tool_name);
    console.log(`| ${toolLabel} | ${fmtNum(r.result_size_bytes as number)} | ${r.duration_ms ?? "—"} | ${r.session_id} | ${r.time} |`);
  }
  console.log();
}

// ── Per-project breakdown ─────────────────────────────────────────────────────────────────────────────────

console.log(`## Per-Project Breakdown\n`);
const perProject = q(`
  SELECT
    COALESCE(project_path, '—') AS project,
    COUNT(DISTINCT session_id) AS sessions,
    SUM(total_turns) AS turns,
    SUM(total_input_tokens + total_output_tokens + total_cached_read + total_cached_write) AS total_tokens,
    SUM(est_cost_usd) AS total_cost
  FROM sessions
  WHERE started_at >= datetime('now', ${WINDOW})
  GROUP BY project_path
  ORDER BY total_cost DESC NULLS LAST
`) as Record<string, unknown>[];

if (perProject.length === 0) {
  console.log("_No session data._\n");
} else {
  console.log("| Project | Sessions | Turns | Total Tokens | Est. Cost |");
  console.log("|---------|----------|-------|--------------|-----------|");
  for (const r of perProject) {
    console.log(`| ${r.project} | ${r.sessions} | ${fmtNum(r.turns as number)} | ${fmtNum(r.total_tokens as number)} | ${fmtCost(r.total_cost as number)} |`);
  }
  console.log();
}

// ── Cache efficiency ──────────────────────────────────────────────────────────────────────────────────────

console.log(`## Cache Efficiency\n`);
const cache = q(`
  SELECT
    COALESCE(provider_id, '—') AS provider,
    COALESCE(model, '—') AS model,
    SUM(COALESCE(cached_read_tokens, 0)) AS cached,
    SUM(COALESCE(cached_write_tokens, 0)) AS cache_writes,
    SUM(COALESCE(input_tokens, 0)) AS fresh,
    ROUND(100.0 * SUM(COALESCE(cached_read_tokens, 0)) /
      NULLIF(SUM(COALESCE(cached_read_tokens, 0) + COALESCE(input_tokens, 0)), 0), 1) AS hit_pct
  FROM turns
  WHERE created_at >= datetime('now', ${WINDOW})
  GROUP BY provider_id, model
  ORDER BY hit_pct DESC
`) as Record<string, unknown>[];

import pricingData from "../src/pricing.json" with { type: "json" };
type PricingEntry = { input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok: number; cache_write_per_mtok: number };
const pricing = pricingData as Record<string, PricingEntry | string>;

function cacheSavings(provider: string, model: string, cacheReadTok: number): string {
  const key = `${provider}/${model}`;
  const entry = pricing[key];
  if (!entry || typeof entry === "string") return "N/A";
  const saved = (cacheReadTok * (entry.input_per_mtok - entry.cache_read_per_mtok)) / 1_000_000;
  return `$${saved.toFixed(4)}`;
}

if (cache.length === 0) {
  console.log("_No cache data._\n");
} else {
  console.log("| Provider | Model | Cache Reads | Cache Writes | Fresh Input | Hit % | Savings vs No-Cache |");
  console.log("|----------|-------|-------------|--------------|-------------|-------|---------------------|");
  for (const r of cache) {
    const savings = cacheSavings(String(r.provider), String(r.model), r.cached as number);
    console.log(`| ${r.provider} | ${r.model} | ${fmtNum(r.cached as number)} | ${fmtNum(r.cache_writes as number)} | ${fmtNum(r.fresh as number)} | ${r.hit_pct ?? "—"}% | ${savings} |`);
  }
  console.log();
}

// ── Orchestration Cost Rollup ──────────────────────────────────────────────────────────────────────────

console.log(`## Orchestration Cost Rollup\n`);
const orchRollup = q(`
  WITH RECURSIVE tree(session_id, root, est_cost_usd, depth) AS (
    SELECT session_id, session_id AS root, COALESCE(est_cost_usd, 0), 0
    FROM sessions
    WHERE parent_session_id IS NULL
      AND started_at >= datetime('now', ${WINDOW})
    UNION ALL
    SELECT s.session_id, t.root, COALESCE(s.est_cost_usd, 0), t.depth + 1
    FROM sessions s
    JOIN tree t ON s.parent_session_id = t.session_id
  )
  SELECT
    root,
    rs.primary_agent AS agent,
    ROUND(MAX(CASE WHEN tree.depth = 0 THEN tree.est_cost_usd END), 5) AS self_cost,
    ROUND(COALESCE(SUM(CASE WHEN tree.depth > 0 THEN tree.est_cost_usd END), 0), 5) AS children_cost,
    ROUND(SUM(tree.est_cost_usd), 5) AS total_cost,
    COUNT(*) - 1 AS children_count
  FROM tree
  JOIN sessions rs ON rs.session_id = tree.root
  GROUP BY root
  HAVING children_count > 0 OR total_cost > 0
  ORDER BY total_cost DESC
  LIMIT 10
`) as Record<string, unknown>[];

if (orchRollup.length === 0) {
  console.log("_No orchestration sessions with child data._\n");
} else {
  console.log("| Root Session | Agent | Self Cost | Children Cost | Total Cost | Children # |");
  console.log("|--------------|-------|-----------|---------------|------------|------------|");
  for (const r of orchRollup) {
    console.log(`| ${r.root} | ${r.agent ?? "—"} | ${fmtCost(r.self_cost as number)} | ${fmtCost(r.children_cost as number)} | ${fmtCost(r.total_cost as number)} | ${r.children_count} |`);
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
console.log(`> hop-level diagnostics, context source analysis, and chain comparisons not shown above.`);
console.log(`> Run \`/telemetry-inspect <session_id>\` for a full per-turn breakdown of any session above.`);
console.log(`> All session IDs above are full and untruncated — copy any to use with \`/telemetry-inspect\`.`);
