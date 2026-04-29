# opencode-telemetry — Implementation Specification

**Audience**: Claude Code (or equivalent agent) implementing this plugin end-to-end in a single working session.

**Goal**: Ship a working open-source opencode plugin that passively logs per-turn telemetry (tokens, tool calls, skills, metadata) to a local SQLite database, with zero friction for the user and useful queries out of the box.

**Time budget**: ~2 hours of focused agent coding.

**Outcome**: A repository ready to publish on npm and GitHub, with a working plugin, a slash command for reports, and a README that lets others adopt it in 2 minutes.

---

## 1. Project Identity

| Field | Value |
|---|---|
| Repo name | `opencode-telemetry` |
| npm package | `opencode-telemetry` (or `@<scope>/opencode-telemetry` if scoped) |
| License | MIT |
| Language | TypeScript |
| Runtime | Bun (opencode runs on Bun) |
| Storage | SQLite (single file, local) |
| Distribution | npm + GitHub |

---

## 2. Design Principles (read these first, they constrain every decision below)

1. **Zero friction**. The plugin must "just work" after install. No manual DB setup, no config required to start, no commands to remember. Auto-create the SQLite file and schema on first event.
2. **Don't duplicate opencode's data**. Opencode already persists full message content. We only store metrics and metadata. To inspect message bodies for a costly session, we query opencode's SDK using the stored `sessionId`.
3. **Privacy-respectful by default**. Never log message bodies, prompt content, or tool result bodies. Only sizes (byte counts and token estimates), timings, and structural metadata.
4. **Fail silent**. If a write fails, log a warning and move on. Telemetry must never break or slow down the user's coding session.
5. **Local-first, no network**. The plugin makes zero outbound network calls. All data stays on disk.
6. **Queryable via plain SQL**. The DB is the API. A user with `sqlite3` can answer any question. Provided slash commands are conveniences, not gatekeepers.
7. **Best-effort fields**. If opencode doesn't provide a field for a given event, store `NULL`. Never crash because a payload is missing a key.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ opencode session                                             │
│                                                              │
│  ┌──────────────┐    events    ┌──────────────────────────┐ │
│  │ User + agents│─────────────▶│ opencode-telemetry plugin│ │
│  └──────────────┘              └────────────┬─────────────┘ │
│                                              │ async writes  │
│                                              ▼               │
│                                  ┌─────────────────────────┐ │
│                                  │ ~/.local/share/         │ │
│                                  │  opencode-telemetry/    │ │
│                                  │  data.db (SQLite)       │ │
│                                  └─────────────────────────┘ │
│                                              ▲               │
│                                              │ reads         │
│                                  ┌────────────┴────────────┐ │
│                                  │ /telemetry-report cmd   │ │
│                                  │ /telemetry-inspect cmd  │ │
│                                  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

The plugin subscribes to opencode plugin events, extracts metrics, and writes asynchronously to SQLite. Two slash commands provide convenience reports. SQL access is always available for power users.

---

## 4. Data Model

### 4.1 Storage location

- **Linux/macOS**: `$XDG_DATA_HOME/opencode-telemetry/data.db` if set, else `~/.local/share/opencode-telemetry/data.db`
- **Windows**: `%LOCALAPPDATA%\opencode-telemetry\data.db`

Directory is created with `mkdir -p` semantics on plugin init. SQLite file is created on first connection.

### 4.2 Schema

Use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` everywhere. Initialization runs once per plugin load (idempotent), not per query.

```sql
-- Sessions table: one row per opencode session, written/updated as session progresses
CREATE TABLE IF NOT EXISTS sessions (
  session_id          TEXT PRIMARY KEY,
  parent_session_id   TEXT,                    -- subagent child sessions reference parent
  started_at          TEXT NOT NULL,           -- ISO 8601 UTC
  ended_at            TEXT,                    -- NULL while active
  primary_agent       TEXT,                    -- e.g. "build", "plan"
  project_path        TEXT,                    -- working directory
  worktree_path       TEXT,
  total_input_tokens  INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cached_read   INTEGER DEFAULT 0,
  total_cached_write  INTEGER DEFAULT 0,
  total_reasoning     INTEGER DEFAULT 0,
  total_turns         INTEGER DEFAULT 0,
  total_tool_calls    INTEGER DEFAULT 0,
  est_cost_usd        REAL,                    -- best-effort, NULL if model unknown
  schema_version      INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);

-- Turns table: one row per assistant message (== one API call)
CREATE TABLE IF NOT EXISTS turns (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT NOT NULL,
  turn_idx            INTEGER NOT NULL,        -- 0-based ordinal within session
  message_id          TEXT,                    -- opencode message id if available
  agent               TEXT,                    -- agent that produced this turn
  model               TEXT,                    -- e.g. "claude-sonnet-4-5"
  provider_id         TEXT,                    -- e.g. "anthropic", "openai", "lmstudio"
  thinking_level      TEXT,                    -- e.g. "low", "medium", "high", "none", or NULL
  input_tokens        INTEGER,                 -- fresh input (non-cached)
  output_tokens       INTEGER,
  cached_read_tokens  INTEGER,
  cached_write_tokens INTEGER,
  reasoning_tokens    INTEGER,
  latency_ms          INTEGER,
  finish_reason       TEXT,                    -- e.g. "stop", "tool_use", "max_tokens"
  created_at          TEXT NOT NULL,           -- ISO 8601 UTC
  UNIQUE(session_id, turn_idx)
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE INDEX IF NOT EXISTS idx_turns_agent_model ON turns(agent, model);
CREATE INDEX IF NOT EXISTS idx_turns_created_at ON turns(created_at);

-- Tool calls table: one row per tool invocation. Skills are tool calls with tool_name='skill'.
CREATE TABLE IF NOT EXISTS tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  turn_idx        INTEGER,                     -- which turn called it; NULL if unknown
  tool_name       TEXT NOT NULL,               -- "bash", "read", "skill", "task", etc.
  skill_name      TEXT,                        -- populated only when tool_name='skill'
  args_size_bytes INTEGER,                     -- byte size of serialized args
  result_size_bytes INTEGER,                   -- byte size of serialized result (NULL on error)
  duration_ms     INTEGER,
  status          TEXT,                        -- "ok", "error", "timeout"
  error_message   TEXT,                        -- truncated to 500 chars max
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_skill ON tool_calls(skill_name) WHERE skill_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_created_at ON tool_calls(created_at);

-- Schema metadata for future migrations
CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Initial seed (idempotent)
INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO _meta (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
```

### 4.3 Field sourcing — what comes from where

This is the most important reference table. The agent implementing the plugin **must verify these against opencode's actual event payloads** before relying on them, because plugin event shapes can evolve. If a field is not present in the actual payload, store `NULL` and add a TODO comment. **Do not invent data.**

| Column | Event source | Notes |
|---|---|---|
| `session_id` | All events | Available on every event |
| `parent_session_id` | `session.created` | Only when subagent spawns a child session |
| `started_at` | `session.created` | Use `new Date().toISOString()` if not in payload |
| `ended_at` | `session.idle` | Mark when session goes idle |
| `primary_agent` | `session.created` or first `message.updated` | Best-effort |
| `agent` (per turn) | `message.updated` | Required for routing analysis |
| `model` | `message.updated` | Required |
| `provider_id` | `message.updated` | Required |
| `thinking_level` | `message.updated` | May be in model options or provider metadata |
| `input_tokens` | `message.updated` | From usage block |
| `output_tokens` | `message.updated` | From usage block |
| `cached_read_tokens` | `message.updated` | Anthropic-specific, may be `cache_read_input_tokens` |
| `cached_write_tokens` | `message.updated` | Anthropic-specific |
| `reasoning_tokens` | `message.updated` | OpenAI o-series specific |
| `latency_ms` | Compute: `tool.execute.after.timestamp - tool.execute.before.timestamp` for tools; for turns, message timing if available |
| `finish_reason` | `message.updated` | If exposed |
| `tool_name` | `tool.execute.before` | Always available |
| `skill_name` | `tool.execute.before.args.name` when `tool === 'skill'` | Verify exact arg key by inspecting payload |
| `args_size_bytes` | `tool.execute.before` | `Buffer.byteLength(JSON.stringify(args))` |
| `result_size_bytes` | `tool.execute.after` | `Buffer.byteLength(JSON.stringify(result))` |
| `duration_ms` | Compute: after - before timestamps | |

### 4.4 Cost estimation

Maintain a static `pricing.json` file in the plugin with per-million-token rates for the models we expect to see. Include input, output, cache_read, cache_write rates.

```json
{
  "anthropic/claude-sonnet-4-5": {
    "input_per_mtok": 3.00,
    "output_per_mtok": 15.00,
    "cache_read_per_mtok": 0.30,
    "cache_write_per_mtok": 3.75
  },
  "anthropic/claude-haiku-4-5": { /* ... */ },
  "openai/gpt-5": { /* ... */ },
  "openai/gpt-5-codex": { /* ... */ }
}
```

Compute `est_cost_usd` per turn: `(input * input_rate + output * output_rate + cache_read * cache_read_rate + cache_write * cache_write_rate) / 1_000_000`. Sum into session total on `session.idle`.

If model not in pricing table, set `est_cost_usd = NULL` (don't fabricate). Add a note in the README that pricing.json is a static snapshot and may need manual updates.

**Initial pricing.json content**: Include at minimum the models the user has flagged (Sonnet 4.6, GPT-5.4) plus common ones (Sonnet/Haiku family, GPT-5/mini, Gemini, common Qwen/Llama for local at $0). Mark "approximate, last updated YYYY-MM" in a top-level comment field.

---

## 5. Plugin Implementation

### 5.1 File layout

```
opencode-telemetry/
├── package.json
├── README.md
├── LICENSE                          (MIT)
├── tsconfig.json
├── .gitignore
├── src/
│   ├── index.ts                     (plugin entry, exports default plugin function)
│   ├── db.ts                        (SQLite init, schema migration, prepared statements)
│   ├── handlers.ts                  (event handlers: onMessageUpdated, onToolBefore, etc.)
│   ├── pricing.ts                   (cost estimator, loads pricing.json)
│   ├── pricing.json                 (static rate table)
│   ├── paths.ts                     (cross-platform DB path resolution)
│   └── types.ts                     (TypeScript interfaces)
├── command/
│   ├── telemetry-report.md          (slash command definition)
│   └── telemetry-inspect.md
├── scripts/
│   ├── db-compat.ts                 (cross-runtime SQLite adapter: bun:sqlite in Bun, node:sqlite in Node ≥22.5)
│   ├── report.ts                    (generates markdown report for last 7 days; run directly via Bun)
│   ├── inspect.ts                   (per-session deep-dive; run directly via Bun)
│   ├── report.js                    (built artifact — Node-compatible bundle; produced by build:scripts, not committed)
│   ├── inspect.js                   (built artifact — Node-compatible bundle; produced by build:scripts, not committed)
│   └── smoke.ts                     (smoke test for DB initialization)
└── queries/
    ├── top-consumers-7d.sql
    ├── ratio-in-out-by-agent.sql
    ├── duplicate-skills.sql
    ├── largest-tool-results.sql
    ├── cache-efficiency.sql
    └── daily-token-trend.sql
```

### 5.2 `package.json` essentials

```json
{
  "name": "opencode-telemetry",
  "version": "0.1.0",
  "description": "Continuous local telemetry for opencode sessions. Tracks tokens, tool calls, and skills per agent/model/session into a local SQLite database.",
  "type": "module",
  "main": "src/index.ts",
  "files": [
    "src/",
    "command/",
    "queries/",
    "scripts/",
    "README.md",
    "LICENSE"
  ],
  "keywords": [
    "opencode",
    "opencode-plugin",
    "telemetry",
    "observability",
    "llm",
    "cost-tracking",
    "agentic"
  ],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/<owner>/opencode-telemetry"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "smoke": "bun run scripts/smoke.ts",
    "build:scripts": "bun build scripts/report.ts scripts/inspect.ts --target=node --external bun:sqlite --outdir=scripts",
    "prepublishOnly": "bun run build:scripts"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": "*"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "*",
    "bun-types": "^1.3.13",
    "typescript": "^5.4.0"
  }
}
```

Note: `better-sqlite3` is **not used**. `bun:sqlite` (built-in, zero external dependency) is used in the plugin core (`src/`) since opencode runs on Bun. The `scripts/` directory uses a cross-runtime adapter (`scripts/db-compat.ts`) that picks `bun:sqlite` in Bun and `node:sqlite` (Node 22.5+ built-in) in Node. See NOTES.md §14 for the full rationale and §13 for the decision not to use `better-sqlite3`.

### 5.3 Plugin entry point (`src/index.ts`) — pseudocode

```typescript
import type { Plugin } from "@opencode-ai/plugin";
import { initDatabase, closeDatabase } from "./db";
import { createHandlers } from "./handlers";

export const TelemetryPlugin: Plugin = async (ctx) => {
  const db = await initDatabase();
  const handlers = createHandlers(db, ctx);

  return {
    "session.created": handlers.onSessionCreated,
    "message.updated": handlers.onMessageUpdated,
    "tool.execute.before": handlers.onToolBefore,
    "tool.execute.after": handlers.onToolAfter,
    "session.idle": handlers.onSessionIdle,
    "session.deleted": handlers.onSessionDeleted, // optional cleanup
  };
};

export default TelemetryPlugin;
```

### 5.4 DB initialization (`src/db.ts`) — requirements

- Resolve DB path via `paths.ts` (XDG-aware, cross-platform).
- `mkdir -p` the parent directory (use `fs.mkdirSync(dir, { recursive: true })`).
- Open SQLite connection.
- Run schema DDL (the full block from §4.2) inside a transaction.
- Set pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`.
- Prepare insert/update statements once and cache them (perf + clarity).
- Export a small wrapper API: `insertTurn`, `upsertSession`, `insertToolCall`, `finalizeSession`.
- Wrap all writes in try/catch; on error, `console.warn("[opencode-telemetry]", err)` and move on. Never throw out of a handler.

### 5.5 Event handlers (`src/handlers.ts`) — behavior

**`onSessionCreated(input)`**
- Insert row into `sessions` with `session_id`, `started_at = now()`, `parent_session_id` (if subagent), `project_path = ctx.directory`, `worktree_path = ctx.worktree`.
- Use `INSERT OR IGNORE` to be idempotent.

**`onMessageUpdated(input)`**
- This event fires multiple times per message as it streams. We only want to record on the **terminal** update (when the message is complete with usage data populated).
- Detection heuristic: only insert when `input.message.usage` is present AND `input.message.role === "assistant"` AND we haven't already logged this `message.id`.
- Maintain an in-memory `Set<string>` of logged message IDs per session to dedupe.
- Compute `turn_idx` as the next ordinal for that session (track per-session counter in memory; on plugin init, seed from `SELECT MAX(turn_idx) FROM turns WHERE session_id = ?`).
- Extract all token fields from `input.message.usage`; map provider-specific names (e.g. Anthropic's `cache_read_input_tokens` → `cached_read_tokens`).
- Extract `agent`, `model`, `provider_id`, `thinking_level` from the message metadata. **Verify these field paths against actual payload — if not present, store NULL with a code-comment TODO.**
- Compute `est_cost_usd` via `pricing.ts`; pass NULL if model unknown.
- Insert row into `turns`.
- Update session totals: `UPDATE sessions SET total_input_tokens = total_input_tokens + ?, ... WHERE session_id = ?`.

**`onToolBefore(input, output)`**
- Capture `start_time` in memory keyed by some correlation ID (the tool execution should have an ID; if not, fall back to `${sessionId}:${toolName}:${counter}`).
- Compute `args_size_bytes = Buffer.byteLength(JSON.stringify(input.args))`.
- Don't insert yet; we wait for `after` to get duration and result size.
- Buffer this in an in-memory `Map<string, PendingToolCall>`.

**`onToolAfter(input, output)`**
- Look up the pending call from the buffer.
- Compute `duration_ms`, `result_size_bytes`, `status` (ok/error based on whether result has error field).
- Special-case skills: if `tool_name === 'skill'`, extract `skill_name` from args (verify exact arg key — likely `name` based on the opencode skill tool signature, but check).
- Insert row into `tool_calls`.
- Increment `sessions.total_tool_calls`.
- Remove from buffer.

**`onSessionIdle(input)`**
- `UPDATE sessions SET ended_at = now() WHERE session_id = ?`.
- Optionally recompute aggregates from turns table to self-heal any drift (run `UPDATE sessions SET total_input_tokens = (SELECT SUM(input_tokens) FROM turns WHERE session_id = ?) ...`).

**`onSessionDeleted(input)`** (optional)
- Delete from `sessions`, `turns`, `tool_calls` for the given `session_id` (foreign key cascading would help but we don't enforce FKs to keep writes simple — do it explicitly in a transaction).

### 5.6 Concurrency and write batching

- All writes are inside synchronous `better-sqlite3` / `bun:sqlite` calls (both are sync APIs). With WAL mode and `synchronous=NORMAL`, writes are fast (sub-millisecond for our row sizes).
- No need for explicit batching at v0.1. If perf becomes an issue (unlikely), add a write queue later.
- The in-memory dedupe sets and pending-tool-call map are per-process. opencode runs one process per session typically, so this is fine. If a process restarts mid-session, we lose in-flight pending tool calls — acceptable v0.1 tradeoff.

---

## 6. Slash Commands

### 6.1 `/telemetry-report`

File: `command/telemetry-report.md`

The command uses a 3-tier fallback to locate and run the report script regardless of how the package was installed:

```bash
bun run "<global-pkg-path>/scripts/report.ts" 2>/dev/null \
  || bun run ~/.config/opencode/plugin/opencode-telemetry/scripts/report.ts 2>/dev/null \
  || node ~/.config/opencode/plugin/opencode-telemetry/scripts/report.js
```

- Tier 1 resolves the global install path via `bun pm ls -g`.
- Tier 2 uses the conventional opencode plugin config directory.
- Tier 3 (Node fallback) runs the pre-built `report.js` bundle, which requires Node ≥ 22.5. This file is produced by `build:scripts` and shipped in the npm package but is not committed to git.

The companion script (`scripts/report.ts` / `scripts/report.js`) runs a fixed set of queries against the SQLite DB and emits markdown:

1. **Headline**: total tokens, total cost (estimated), total sessions, total turns — last 7 days.
2. **Top 10 sessions by cost** — `session_id`, agent, model, total cost, total turns.
3. **Per-agent breakdown** — agent, total tokens (in/out), avg ratio in/out, total cost.
4. **Per-model breakdown** — model, calls, total tokens, total cost.
5. **Skill usage** — skill_name, calls, sessions where called >1 time (potential bloat).
6. **Largest tool result outputs** — top 10 individual `result_size_bytes`, with tool name and session.
7. **Cache efficiency** — cache_read / (cache_read + input) per provider.

Each section is a small markdown table generated from one SQL query.

### 6.2 `/telemetry-inspect`

File: `command/telemetry-inspect.md`

Same 3-tier fallback pattern as `/telemetry-report`, passing `$ARGUMENTS` (the session ID) to the script:

```bash
bun run "<global-pkg-path>/scripts/inspect.ts" "$ARGUMENTS" 2>/dev/null \
  || bun run ~/.config/opencode/plugin/opencode-telemetry/scripts/inspect.ts "$ARGUMENTS" 2>/dev/null \
  || node ~/.config/opencode/plugin/opencode-telemetry/scripts/inspect.js "$ARGUMENTS"
```

The inspect script outputs:
- Session metadata (started, ended, agent, project, parent if subagent)
- Per-turn metrics table (turn_idx, agent, model, in_tok, out_tok, cached, cost, latency)
- Tool call timeline (chronological, with sizes and durations)
- Skill loads in this session, with counts (highlight duplicates)
- Total cost breakdown

---

## 7. Pre-canned Queries (`queries/`)

Each is a standalone `.sql` file the user can run with `sqlite3 ~/.local/share/opencode-telemetry/data.db < queries/top-consumers-7d.sql`. The README documents this usage. **The implementer should write actual working SQL** matching the schema — examples below are representative shapes only.

**`top-consumers-7d.sql`** — top 20 sessions by est_cost_usd in last 7 days.
```sql
SELECT
  s.session_id,
  s.primary_agent,
  s.project_path,
  s.total_input_tokens + s.total_output_tokens AS total_tokens,
  s.est_cost_usd,
  s.total_turns,
  s.started_at
FROM sessions s
WHERE s.started_at >= datetime('now', '-7 days')
  AND s.est_cost_usd IS NOT NULL
ORDER BY s.est_cost_usd DESC
LIMIT 20;
```

**`ratio-in-out-by-agent.sql`** — input/output token ratio per agent (high ratio = context bloat suspect).
```sql
SELECT
  agent,
  model,
  SUM(input_tokens + cached_read_tokens) AS total_in,
  SUM(output_tokens) AS total_out,
  ROUND(1.0 * SUM(input_tokens + cached_read_tokens) / NULLIF(SUM(output_tokens), 0), 1) AS in_out_ratio,
  COUNT(*) AS turns
FROM turns
WHERE created_at >= datetime('now', '-7 days')
GROUP BY agent, model
ORDER BY in_out_ratio DESC;
```

**`duplicate-skills.sql`** — skills loaded multiple times in the same session.
```sql
SELECT
  session_id,
  skill_name,
  COUNT(*) AS load_count,
  SUM(result_size_bytes) AS cumulative_bytes
FROM tool_calls
WHERE tool_name = 'skill' AND skill_name IS NOT NULL
GROUP BY session_id, skill_name
HAVING load_count > 1
ORDER BY cumulative_bytes DESC
LIMIT 50;
```

**`largest-tool-results.sql`** — biggest individual tool result payloads.
```sql
SELECT
  session_id,
  tool_name,
  result_size_bytes,
  duration_ms,
  created_at
FROM tool_calls
WHERE result_size_bytes IS NOT NULL
ORDER BY result_size_bytes DESC
LIMIT 50;
```

**`cache-efficiency.sql`** — cache hit rate by provider/model.
```sql
SELECT
  provider_id,
  model,
  SUM(cached_read_tokens) AS cached,
  SUM(input_tokens) AS fresh,
  ROUND(100.0 * SUM(cached_read_tokens) / NULLIF(SUM(cached_read_tokens + input_tokens), 0), 1) AS cache_hit_pct
FROM turns
WHERE cached_read_tokens IS NOT NULL
GROUP BY provider_id, model
ORDER BY cache_hit_pct ASC;
```

**`daily-token-trend.sql`** — daily totals for the last 30 days.
```sql
SELECT
  DATE(created_at) AS day,
  SUM(input_tokens + cached_read_tokens) AS input_total,
  SUM(output_tokens) AS output_total,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(*) AS turns
FROM turns
WHERE created_at >= datetime('now', '-30 days')
GROUP BY day
ORDER BY day DESC;
```

---

## 8. README.md content (write this for end users)

The README is the front door of the open-source project. Structure:

1. **Headline**: name + tagline.
2. **What it does**: 4-bullet summary.
3. **What it does NOT do**: explicitly disclaim — no message body logging, no network calls, no cloud, no real-time UI.
4. **Install**: one paragraph (npm install + add to `opencode.json`).
5. **Usage**: `/telemetry-report`, `/telemetry-inspect <session_id>`, raw SQL access.
6. **Schema overview**: link to source, brief description.
7. **Pricing accuracy**: explain `pricing.json` is static, list last-updated date, invite PRs.
8. **Privacy**: explicit section. Local-only, no telemetry phone-home, no message bodies stored.
9. **Roadmap**: short. (auto-cleanup TTL, more queries, web dashboard if requested).
10. **Contributing**: standard.
11. **License**: MIT.

Tone: matter-of-fact, no marketing fluff. The other plugins in the opencode ecosystem (tokenscope, opencode-quota) set the tone — read them for reference.

---

## 9. Implementation Order (the agent should follow this strictly)

The agent has ~2 hours. Here's the order, with a hard checkpoint after each block. **If a block runs over by more than ~25%, simplify rather than skip. Better a working v0.1 than a half-done v0.5.**

**Block 1 (target 30 min): Skeleton + DB**
- Initialize repo with `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`.
- Implement `src/paths.ts` and `src/db.ts` with full schema creation.
- Smoke test: import db.ts in a tiny script, verify the DB file gets created with correct tables. Use `sqlite3 <path> ".schema"`.

**Block 2 (target 40 min): Event handlers**
- Implement `src/handlers.ts` for all 5 events.
- Implement `src/index.ts` plugin entry.
- **Field discovery step**: before fully implementing handlers, run a tiny diagnostic version of the plugin that just `console.log`s every event payload it receives, install it locally in opencode, run one short session. Use the actual payload shapes to confirm field paths. This is non-negotiable — guessing payload shapes wastes more time than discovering them.
- After discovery, fill in handlers properly.
- Smoke test: install plugin in local opencode, run a session with a few tool calls, verify rows appear in DB.

**Block 3 (target 20 min): Pricing + cost computation**
- Implement `src/pricing.ts` and `src/pricing.json` with at least: Sonnet 4.6, Haiku, Opus, GPT-5/codex/mini, Gemini Pro, common locals at $0.
- Wire cost computation into `onMessageUpdated`.
- Smoke test: query `est_cost_usd` for known sessions, sanity-check magnitude.

**Block 4 (target 15 min): Slash commands + report script**
- Write `command/telemetry-report.md` and the report script that emits markdown.
- Write `command/telemetry-inspect.md` and the inspect script.
- Smoke test: run `/telemetry-report` in opencode, see output.

**Block 5 (target 10 min): SQL queries + README**
- Drop the 6 query files in `queries/`.
- Write README following §8.

**Block 6 (target 5 min): Final polish**
- Add a few `console.warn` calls for known failure modes.
- Test the full install path: `npm pack`, `npm install -g ./opencode-telemetry-0.1.0.tgz`, add to `opencode.json`, restart, run a session, run `/telemetry-report`.
- Tag v0.1.0 in git.

---

## 10. Things to verify against actual opencode behavior (don't skip this)

These are the points where the spec assumes payloads/behavior that the agent **must verify** before relying on them. Document any deviation in a `NOTES.md` or in code comments.

1. **`message.updated` event**: does it fire multiple times per message (streaming) or once at completion? Does the final fire have full `usage` data populated?
2. **`message.usage` field names**: Anthropic uses `cache_read_input_tokens` / `cache_creation_input_tokens` — confirm opencode preserves these exact keys or normalizes them.
3. **Skill tool argument shape**: when the model calls `skill`, what is the exact arg schema? Likely `{ name: "skill-id" }` but verify.
4. **Subagent session relationship**: how exactly is the parent-child link expressed in `session.created` payload? (Could be `parentId`, `parent_session_id`, nested in metadata, etc.)
5. **`thinking_level` / reasoning effort**: where is this surfaced in `message.updated`? It may live under `provider_metadata`, `model_options`, or only be inferable from token-usage signature (if `reasoning_tokens > 0` then thinking was active).
6. **Tool ID for correlating before/after**: is there an explicit `tool_call_id` or do we need to fall back on session+name+ordinal?
7. **`ctx.directory` and `ctx.worktree`**: confirm these are correct fields on the plugin context per the docs.

If any of these are different from assumptions, **adjust the schema/handlers and document the change in a `NOTES.md`** included in the repo. Future maintainers (and the user) need to know.

---

## 11. Out of scope for v0.1 (do not implement)

- Web dashboard / TUI integration.
- Network egress of any kind.
- Auto-update of `pricing.json` from external source.
- Anomaly detection or alerting.
- Cross-machine sync.
- Per-message body logging (this is a privacy decision, document it in README).
- Schema migrations beyond v1 (the `_meta` table is there to enable future migrations; we just don't need any yet).
- Configuration file. Defaults are fine for v0.1. Add config in v0.2 if needed.

---

## 12. Definition of Done

The plugin is "v0.1 done" when:
- [ ] A user can `npm install opencode-telemetry`, add it to `opencode.json` plugin array, restart opencode, and the DB file is created automatically on first event.
- [ ] One session of normal coding produces correctly-populated rows in `sessions`, `turns`, and `tool_calls`.
- [ ] `/telemetry-report` produces a sensible markdown report.
- [ ] `/telemetry-inspect <session_id>` produces a sensible per-session breakdown.
- [ ] Power users can run any of the 6 SQL queries directly via `sqlite3` CLI and get answers.
- [ ] No errors thrown into the user's coding session even under unusual conditions (missing fields, model not in pricing table, very fast tool calls, etc.).
- [ ] README explains install, use, schema, privacy, and pricing accuracy clearly.
- [ ] `NOTES.md` documents any deviations from this spec discovered during implementation.

---

## 13. Notes for the implementing agent

- **Read this whole spec before starting.** It will save you backtracking.
- **The "verify against actual behavior" step in §10 is critical.** Run the diagnostic logger first. Don't implement against assumed payload shapes.
- **Privacy is non-negotiable.** No message body logging. No network calls. The README must say this clearly.
- **Fail silent.** Wrap every handler in try/catch. Telemetry breaking the user's flow defeats the purpose.
- **Keep it small.** v0.1 is meant to be ~600-800 lines of code total including types and SQL. If you're heading toward 2000, you're over-engineering.
- **Commit incrementally.** One commit per block in §9. The user will publish this and others will read the history.

End of spec.
