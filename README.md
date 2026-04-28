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

A full 7-day summary rendered as markdown — headline stats, top sessions by cost, per-agent and per-model breakdowns, skill usage, and cache efficiency:

```
# Telemetry Report — Last 7 Days

| Metric        | Value     |
|---------------|-----------|
| Sessions      | 24        |
| Turns         | 187       |
| Total Tokens  | 2,341,880 |
| Est. Cost     | $9.2341   |

## Top 10 Sessions by Cost

| Session       | Agent        | Tokens    | Cost    | Turns | Started          |
|---------------|--------------|-----------|---------|-------|------------------|
| 3f9a1b2c4d5e… | claude-code  | 312,440   | $1.8821 | 22    | 2026-04-27 14:03 |
| a1b2c3d4e5f6… | claude-code  | 198,770   | $1.2041 | 14    | 2026-04-26 09:51 |
| ...           |              |           |         |       |                  |

## By Model

| Model                        | Turns | Input Tok   | Output Tok | Est. Cost |
|------------------------------|-------|-------------|------------|-----------|
| anthropic/claude-sonnet-4-6  | 134   | 1,441,200   | 287,340    | $6.5812   |
| anthropic/claude-haiku-4-5   | 53    | 389,100     | 72,440     | $0.6021   |
```

### `/telemetry-inspect <session_id>`

Deep-dive into a single session: turn-by-turn metrics, tool call timeline, skill load summary, and full cost breakdown.

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
├── primary_agent       TEXT
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
