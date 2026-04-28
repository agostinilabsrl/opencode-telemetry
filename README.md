# opencode-telemetry

Passively logs per-turn telemetry for [opencode](https://opencode.ai) sessions into a local SQLite database. Zero configuration required.

## What it does

- Records every assistant turn: tokens (input/output/cached/reasoning), model, provider, agent, latency, finish reason, and estimated cost.
- Records every tool call: name, skill name (for `skill` tool), args size, result size, duration, and status.
- Tracks session metadata: project path, parent session (for subagents), start/end time, and aggregate totals.
- Provides `/telemetry-report` and `/telemetry-inspect` slash commands for quick analysis from within opencode.

## What it does NOT do

- **No message body logging.** Prompt content and tool result text are never stored — only byte sizes and token counts.
- **No network calls.** All data stays on your machine. Zero outbound requests, ever.
- **No cloud, no accounts, no real-time UI.** The SQLite file is the API.

## Install

```bash
npm install opencode-telemetry
```

Add to your `opencode.json`:

```json
{
  "plugin": [
    "opencode-telemetry"
  ]
}
```

Restart opencode. The database is created automatically on the first session event — no setup needed.

## Usage

### Slash commands (inside opencode)

```
/telemetry-report
```
Outputs a markdown report covering the last 7 days: headline stats, top sessions by cost, per-agent and per-model breakdowns, skill usage, largest tool results, and cache efficiency.

```
/telemetry-inspect <session_id>
```
Deep-dives into a single session: turn-by-turn metrics, tool call timeline, skill load summary, and cost breakdown.

### Direct SQL access

The database lives at `~/.local/share/opencode-telemetry/data.db` (Linux/macOS) or `%LOCALAPPDATA%\opencode-telemetry\data.db` (Windows).

Pre-canned queries are in the `queries/` directory:

```bash
DB=~/.local/share/opencode-telemetry/data.db

# Top sessions by cost this week
sqlite3 $DB < queries/top-consumers-7d.sql

# Context bloat suspects (high input/output ratio)
sqlite3 $DB < queries/ratio-in-out-by-agent.sql

# Skills loaded multiple times in the same session
sqlite3 $DB < queries/duplicate-skills.sql

# Largest tool result payloads
sqlite3 $DB < queries/largest-tool-results.sql

# Cache hit rate by model
sqlite3 $DB < queries/cache-efficiency.sql

# Daily token trend (last 30 days)
sqlite3 $DB < queries/daily-token-trend.sql
```

Or any ad-hoc SQL:

```bash
sqlite3 ~/.local/share/opencode-telemetry/data.db \
  "SELECT model, SUM(input_tokens+output_tokens) AS tok FROM turns GROUP BY model ORDER BY tok DESC;"
```

## Schema

Three main tables — see [`src/db.ts`](src/db.ts) for the full DDL.

| Table | One row per… |
|-------|-------------|
| `sessions` | opencode session |
| `turns` | assistant message (= one API call) |
| `tool_calls` | tool invocation |

Plus `_meta` for schema versioning.

## Pricing accuracy

`src/pricing.json` is a **static snapshot** (last updated April 2026). It covers Anthropic Claude (Opus/Sonnet/Haiku), OpenAI (GPT-4.5, GPT-4.1, o3, o4-mini), Google Gemini (2.5 Pro/Flash), and common local models (at $0). If a model is not in the table, `est_cost_usd` is stored as `NULL` — never fabricated.

Rates drift over time. PRs to update `pricing.json` are welcome.

## Privacy

- **Local only.** The plugin makes no outbound network calls.
- **No prompt content stored.** Only byte sizes, token counts, timings, and structural metadata are persisted.
- **No telemetry phone-home.** The plugin itself is not instrumented.

## Roadmap

- Auto-cleanup TTL (delete sessions older than N days)
- More pre-canned queries (anomaly detection, cost forecasting)
- Web dashboard (if there's demand)

## Contributing

PRs welcome — especially for `pricing.json` updates and new queries. Please keep the plugin itself under ~800 lines of source.

## License

MIT
