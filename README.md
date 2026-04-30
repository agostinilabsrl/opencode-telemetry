# opencode-telemetry

> **Know exactly what your AI sessions are costing you** — tokens, tools, agents, and dollars, stored locally in a queryable SQLite database. Zero config. Zero cloud. Zero noise.

[![npm](https://img.shields.io/npm/v/opencode-telemetry?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/opencode-telemetry)
[![license](https://img.shields.io/npm/l/opencode-telemetry?color=blue)](LICENSE)
[![runtime](https://img.shields.io/badge/runtime-bun-fbf0df?logo=bun&logoColor=000)](https://bun.sh)
[![opencode](https://img.shields.io/badge/plugin-opencode-6c47ff)](https://opencode.ai)

---

## Why?

You're running AI sessions all day. You probably have **no idea**:

- Which agent burned $4 this morning in three turns
- Which model your pipeline actually ended up calling
- Whether prompt caching is actually kicking in
- How much a single "quick fix" session cost vs a deep refactor

`opencode-telemetry` plugs into [opencode](https://opencode.ai) and silently logs everything that matters — per turn, per tool call, per session — into a local SQLite file you can query however you like.

---

## Prerequisites

The telemetry plugin itself always runs inside opencode's own Bun process, so the
database is created and populated regardless of what is in your `PATH`.

The **slash commands** (`/telemetry-report`, `/telemetry-inspect`) require:

- **[Bun](https://bun.sh) ≥ 1.0** in `PATH` — this is a hard requirement

> **Note:** A Node.js ≥ 22.5 fallback (via `node:sqlite`) was attempted but is not
> currently working correctly. Until that is resolved, **Bun must be available in your
> `PATH`** for the slash commands to function. opencode itself ships with Bun, so
> running `bun` from your shell is usually just an install away: https://bun.sh/docs/installation

---

## Install

```bash
npm install opencode-telemetry
```

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-telemetry"]
}
```

Restart opencode. The database is created automatically on the first event — no setup, no migration, no config file.

> **Note:** `npm install opencode-telemetry` is sufficient for telemetry collection.
> For the slash commands to work, `bun` must be available in `PATH`.

> **Database location**
> `~/.local/share/opencode-telemetry/data.db` on Linux/macOS
> `%LOCALAPPDATA%\opencode-telemetry\data.db` on Windows

---

## What you get

| | |
|---|---|
| **Per turn** | Input / output / cached / reasoning tokens, model, agent, latency, finish reason, estimated cost |
| **Per tool call** | Tool name, skill name, args size, result size, duration, success/error |
| **Per session** | Project path, parent session (subagents), start/end time, aggregate totals |

All stored in three plain SQL tables. No proprietary format, no lock-in.

---

## Slash commands

Run these from inside opencode for instant reports.

### `/telemetry-report`

A full 7-day summary rendered as markdown — headline stats, top sessions (with full IDs and slash command entrypoints), per-agent breakdown with cache hit %, per-model breakdown, tool result size stats (p50/p95), skill usage, and cache efficiency:

```
# Telemetry Report — Last 7 Days

| Metric        | Value     |
|---------------|-----------|
| Sessions      | 24        |
| Turns         | 187       |
| Total Tokens  | 2,341,880 |
| Est. Cost     | $9.2341   |

## Top 10 Sessions by Cost

| Session ID                           | Command | Agent       | Tokens    | Cost    | Turns | Started          |
|--------------------------------------|---------|-------------|-----------|---------|-------|------------------|
| 3f9a1b2c-4d5e-6f7a-8b9c-0d1e2f3a4b5c | /forge  | forge       | 312,440   | $1.8821 | 22    | 2026-04-27 14:03 |
| a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d | /swarm  | conductor   | 198,770   | $1.2041 | 14    | 2026-04-26 09:51 |
...

## Per-Agent Breakdown

| Agent     | Total In    | Total Out | In/Out | Turns | Cache Hit % |
|-----------|-------------|-----------|--------|-------|-------------|
| general   | 22,920,701  | 174,980   | 131    | 641   | 68.2%       |
| conductor | 15,137,011  | 112,143   | 135    | 264   | 71.4%       |
```

### `/telemetry-inspect <session_id>`

Deep-dive into a single session: metadata (including slash command entrypoint), sub-session agent hops, agent chain summary with cache hit %, turn-by-turn metrics, tool call timeline, per-tool result size stats, skill load summary, and full cost breakdown.

Accepts full session IDs or unique prefixes.

### `/telemetry-db-analyst`

A skill that gives opencode direct SQL access to the telemetry database for custom analysis:
- Per-hop token breakdown for multi-agent chain runs
- Context growth analysis (cumulative input tokens across turns)
- Tool result p50/p95 by tool type
- Cost comparison across runs of the same slash command
- Any ad-hoc query not covered by the canned reports

---

## Direct SQL access

The SQLite file is the API. Every query you can imagine, any tool you already use.

```bash
DB=~/.local/share/opencode-telemetry/data.db

# Top sessions by cost this week
sqlite3 $DB < queries/top-consumers-7d.sql

# Is prompt caching actually working?
sqlite3 $DB < queries/cache-efficiency.sql

# Which agents have bloated context (high input/output ratio)?
sqlite3 $DB < queries/ratio-in-out-by-agent.sql

# Skills loaded more than once in the same session (wasted tokens)
sqlite3 $DB < queries/duplicate-skills.sql

# Largest tool result payloads
sqlite3 $DB < queries/largest-tool-results.sql

# Daily token trend — last 30 days
sqlite3 $DB < queries/daily-token-trend.sql
```

Or go fully ad-hoc:

```bash
sqlite3 $DB \
  "SELECT model, SUM(input_tokens+output_tokens) AS tok
   FROM turns GROUP BY model ORDER BY tok DESC;"
```

Works with any SQLite client — [DB Browser for SQLite](https://sqlitebrowser.org), [Datasette](https://datasette.io), [TablePlus](https://tableplus.com), Grafana, whatever you already have.

---

## Schema

Three tables, no surprises.

```
sessions
├── session_id          TEXT  PRIMARY KEY
├── project_path        TEXT
├── primary_agent       TEXT  (first agent seen in session)
├── slash_command       TEXT  (inferred from primary_agent, e.g. /forge)
├── parent_session_id   TEXT  (set for subagent sessions)
├── started_at          TEXT
├── ended_at            TEXT
├── total_turns         INTEGER
├── total_input_tokens  INTEGER
├── total_output_tokens INTEGER
├── total_cached_read   INTEGER
├── total_cached_write  INTEGER
└── est_cost_usd        REAL

turns
├── turn_id             TEXT  PRIMARY KEY
├── session_id          TEXT  → sessions
├── model               TEXT
├── provider            TEXT
├── agent               TEXT
├── input_tokens        INTEGER
├── output_tokens       INTEGER
├── cached_read_tokens  INTEGER
├── cached_write_tokens INTEGER
├── reasoning_tokens    INTEGER
├── latency_ms          INTEGER
├── finish_reason       TEXT
├── thinking_level      TEXT
├── turn_index          INTEGER
├── created_at          TEXT
└── est_cost_usd        REAL

tool_calls
├── call_id             TEXT  PRIMARY KEY
├── session_id          TEXT  → sessions
├── turn_id             TEXT  → turns
├── tool_name           TEXT
├── skill_name          TEXT  (populated for skill tool invocations)
├── args_bytes          INTEGER
├── result_bytes        INTEGER
├── duration_ms         INTEGER
├── status              TEXT  (success | error | timeout)
└── called_at           TEXT
```

Full DDL: [`src/db.ts`](src/db.ts)

---

## Supported models

Cost estimates (`est_cost_usd`) are calculated for:

| Provider  | Models |
|-----------|--------|
| Anthropic | Claude Opus 4, Sonnet 4.6 / 4.5, Haiku 4.5 |
| OpenAI    | GPT-4.5, GPT-4.1, o3, o4-mini |
| Google    | Gemini 2.5 Pro, Gemini 2.5 Flash |
| Local     | Any local/ollama model (rates = $0) |

`est_cost_usd` is stored as `NULL` for unknown models — never fabricated. Rates are a static snapshot; PRs to update [`src/pricing.json`](src/pricing.json) are welcome.

---

## Privacy

- **Local only.** No network calls, ever. The plugin has no outbound connectivity.
- **No prompt content.** Only byte sizes, token counts, timings, and structural metadata are stored. Your prompts and tool results are never written to disk by this plugin.
- **No phone-home.** The plugin itself is not instrumented or tracked.

---

## Roadmap

- [ ] Auto-cleanup TTL (purge sessions older than N days)
- [ ] Anomaly detection queries (cost spikes, token regressions)
- [ ] Web dashboard — if there's demand, open an issue

---

## Contributing

PRs welcome — especially for `pricing.json` updates and new canned queries.
Please keep the plugin source under ~800 lines total.

## License

[MIT](LICENSE)
