#!/usr/bin/env bun
// Generates a markdown telemetry report for the last 7 days.
import { openDatabase } from "./db-compat.ts";
import { getDbPath } from "../src/paths.ts";
import fs from "fs";

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

const WINDOW = "'-7 days'";

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

console.log(`# Telemetry Report — Last 7 Days\n`);
console.log(`| Metric | Value |`);
console.log(`|--------|-------|`);
console.log(`| Sessions | ${fmtNum(headline?.sessions as number)} |`);
console.log(`| Turns | ${fmtNum(headline?.turns as number)} |`);
console.log(`| Total Tokens | ${fmtNum(headline?.total_tokens as number)} |`);
console.log(`| Est. Cost | ${fmtCost(headline?.total_cost as number)} |`);
console.log();

// ── Top 10 sessions by cost ───────────────────────────────────────────────────────────────────────────

console.log(`## Top 10 Sessions by Cost\n`);
const topSessions = q(`
  SELECT
    session_id AS id,
    COALESCE(slash_command, CASE WHEN primary_agent IS NOT NULL THEN '/' || primary_agent ELSE '—' END) AS command,
    COALESCE(primary_agent, '—') AS agent,
    COALESCE(project_path, '—') AS project,
    total_input_tokens + total_output_tokens AS tokens,
    est_cost_usd AS cost,
    total_turns AS turns,
    substr(started_at, 1, 16) AS started
  FROM sessions
  WHERE started_at >= datetime('now', ${WINDOW})
    AND est_cost_usd IS NOT NULL
  ORDER BY est_cost_usd DESC
  LIMIT 10
`) as Record<string, unknown>[];

if (topSessions.length === 0) {
  console.log("_No sessions with cost data._\n");
} else {
  console.log("| Session ID | Command | Agent | Tokens | Cost | Turns | Started |");
  console.log("|------------|---------|-------|--------|------|-------|---------|")
  for (const r of topSessions) {
    console.log(`| ${r.id} | ${r.command} | ${r.agent} | ${fmtNum(r.tokens as number)} | ${fmtCost(r.cost as number)} | ${r.turns} | ${r.started} |`);
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
  SELECT
    tool_name,
    COUNT(*) AS calls,
    CAST(AVG(result_size_bytes) AS INTEGER) AS avg_bytes,
    MAX(result_size_bytes) AS max_bytes,
    CAST(result_size_bytes AS INTEGER) AS p50_bytes
  FROM (
    SELECT tool_name, result_size_bytes,
      ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY result_size_bytes) AS rn,
      COUNT(*) OVER (PARTITION BY tool_name) AS cnt
    FROM tool_calls
    WHERE result_size_bytes IS NOT NULL
      AND created_at >= datetime('now', ${WINDOW})
  )
  WHERE rn = (cnt + 1) / 2
  GROUP BY tool_name
  ORDER BY avg_bytes DESC
  LIMIT 20
`) as Record<string, unknown>[];

// Compute p95 separately
const toolP95 = q(`
  SELECT
    tool_name,
    CAST(result_size_bytes AS INTEGER) AS p95_bytes
  FROM (
    SELECT tool_name, result_size_bytes,
      ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY result_size_bytes) AS rn,
      COUNT(*) OVER (PARTITION BY tool_name) AS cnt
    FROM tool_calls
    WHERE result_size_bytes IS NOT NULL
      AND created_at >= datetime('now', ${WINDOW})
  )
  WHERE rn = MAX(1, CAST(cnt * 0.95 AS INTEGER))
`) as Record<string, unknown>[];

const p95Map = new Map<string, number>();
for (const r of toolP95) {
  p95Map.set(r.tool_name as string, r.p95_bytes as number);
}

if (toolStats.length === 0) {
  console.log("_No tool call data._\n");
} else {
  console.log("| Tool | Calls | Avg (B) | p50 (B) | p95 (B) | Max (B) |");
  console.log("|------|-------|---------|---------|---------|---------|")
  for (const r of toolStats) {
    const p95 = p95Map.get(r.tool_name as string);
    console.log(`| ${r.tool_name} | ${r.calls} | ${fmtNum(r.avg_bytes as number)} | ${fmtNum(r.p50_bytes as number)} | ${fmtNum(p95 ?? null)} | ${fmtNum(r.max_bytes as number)} |`);
  }
  console.log();
}

// ── Skill usage ───────────────────────────────────────────────────────────────────────────────────

console.log(`## Skill Usage\n`);
const skills = q(`
  SELECT
    skill_name,
    COUNT(*) AS calls,
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
    SUM(COALESCE(input_tokens, 0)) AS fresh,
    ROUND(100.0 * SUM(COALESCE(cached_read_tokens, 0)) /
      NULLIF(SUM(COALESCE(cached_read_tokens, 0) + COALESCE(input_tokens, 0)), 0), 1) AS hit_pct
  FROM turns
  WHERE created_at >= datetime('now', ${WINDOW})
  GROUP BY provider_id, model
  ORDER BY hit_pct DESC
`) as Record<string, unknown>[];

if (cache.length === 0) {
  console.log("_No cache data._\n");
} else {
  console.log("| Provider | Model | Cached | Fresh | Hit % |");
  console.log("|----------|-------|--------|-------|-------|")
  for (const r of cache) {
    console.log(`| ${r.provider} | ${r.model} | ${fmtNum(r.cached as number)} | ${fmtNum(r.fresh as number)} | ${r.hit_pct ?? "—"}% |`);
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
