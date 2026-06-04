# opencode-telemetry

Local-first historical telemetry for opencode sessions. Track where your tokens go in agent orchestration chains — without external infrastructure.

[![npm](https://img.shields.io/npm/v/opencode-telemetry?color=CB3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/opencode-telemetry)

## What it does

- Logs every opencode session to a local SQLite database automatically
- Aggregates costs across orchestration chains (conductor + all child sessions), showing the true total rather than just the parent's share
- Forensic per-session inspection: full token trajectory, turn-by-turn context growth, identified delta drivers ("turn 32 grew by 20k tokens — likely a 41KB bash result entered history")
- CLI binary (`octm`) generates and saves reports to disk without consuming model tokens to re-emit them
- Zero external dependencies — your data stays on your machine, no collectors required

## When to use this plugin

The opencode ecosystem has several telemetry plugins with different scopes. Pick the one that matches your need:

| Need | Plugin |
|------|--------|
| Inspect a live session interactively to see how tokens are split right now | [Opencode-Context-Analysis-Plugin](https://github.com/IgorWarzocha/Opencode-Context-Analysis-Plugin) by Igor Warzocha |
| Deep on-demand breakdown of a single session (context composition, tool-schema sizing, cache efficiency) via a slash command | [Tokenscope](https://github.com/ramtinJ95/opencode-tokenscope) by ramtinJ95 |
| Stream telemetry to an existing observability backend (Datadog, Honeycomb, Grafana Cloud) | [opencode-plugin-otel](https://github.com/DEVtheOPS/opencode-plugin-otel) by DEVtheOPS |
| Analyze sessions historically, forensically, locally, across runs, with no infrastructure | **opencode-telemetry** (this plugin) |

The distinction that matters: Tokenscope and Igor's plugin run on demand against the session you point them at — they answer "what does *this* session look like right now?". opencode-telemetry runs passively and persists every session to SQLite, so it answers "what happened across all my sessions last week, and which orchestration chains cost the most?". They are complementary: use Tokenscope for a deep one-shot autopsy, use this plugin for cross-session history and orchestration-chain rollups.

These plugins are complementary, not competing. You can install more than one.

This plugin is built for users who:
- Run complex orchestration chains (e.g. agent swarms with parent/child session dispatch)
- Want to analyze sessions days or weeks after they ran
- Don't have or want an OpenTelemetry collector running
- Need turn-by-turn forensics to understand "where did those tokens actually go?"

We owe a debt of inspiration to the projects above — the live-decomposition approach (Igor), the deep per-session context breakdown (Tokenscope), and the streaming-export model (DEVtheOPS). This plugin fills the remaining corner: persistent, local, forensic, cross-session.

## Installation

```bash
npm install -g opencode-telemetry
# or
bun add -g opencode-telemetry
```

Add to your opencode config (`~/.config/opencode/config.json`):

```json
{
  "plugins": [
    "opencode-telemetry"
  ]
}
```

The plugin starts logging automatically. No configuration required.

## Quickstart

### Pattern 1 — Just install and forget

The plugin starts logging automatically. Nothing to configure. Sessions land in `~/.local/share/opencode-telemetry/data.db`.

### Pattern 2 — Get a 7-day report

From terminal (no model token cost):
```bash
octm report
```

Or from inside opencode (saves to file, returns the path):
```
/telemetry-report
```

### Pattern 3 — Forensic inspect of a specific session

```bash
octm inspect ses_2073813f
```

Add `--content` to fetch and analyze the full prompt content for every turn (requires opencode server running; results are cached locally):

```bash
octm inspect ses_2073813f --content
```

This produces a report with:
- Token trajectory chart across all turns
- Top turn deltas with identified causes
- Agent chain breakdown
- Child session rollup with aggregated costs

## Commands reference

### `octm` CLI

```
octm report [--days N] [--save] [--no-save] [--format md|json]
  Generate a report for the last N days (default: 7).
  Saves to ~/.local/share/opencode-telemetry/reports/ by default.
  --no-save: print to stdout only.
  --format json: output structured JSON.

octm inspect <session_id> [--content] [--save] [--no-save]
  Deep-dive into a session. Supports ID prefix matching.
  --content: fetch and analyze full prompt content (lazy, cached).
  Saves to ~/.local/share/opencode-telemetry/reports/ by default.

octm config show
octm config get <key>
octm config set <key> <value>
octm config reset
  Manage ~/.config/opencode-telemetry/config.json.
  Keys use dot notation: content_cache.enabled, sdk_bridge.enabled, deployment_mode.

octm cache stats
octm cache clear [--older-than <N>d]
octm cache prefetch <session_id>
  Manage the content cache.

octm sql "<query>"
octm sql --file <path>
  Run a read-only SQL query against the telemetry DB.

octm help
```

### Slash commands

| Command | What it does |
|---------|-------------|
| `/telemetry-report` | Runs `octm report --save`, returns the saved file path |
| `/telemetry-inspect <session_id>` | Runs `octm inspect --save`, returns the saved file path |
| `/telemetry-db-analyst` | Opens a SQL skill for direct DB access |

Slash commands return only the file path — they do not re-emit report contents through the model.

## Configuration

Config file: `~/.config/opencode-telemetry/config.json`

```json
{
  "version": 1,
  "content_cache": {
    "enabled": true,
    "path": "~/.local/share/opencode-telemetry/content-cache"
  },
  "sdk_bridge": {
    "enabled": true
  },
  "deployment_mode": "auto"
}
```

| Key | Values | Description |
|-----|--------|-------------|
| `content_cache.enabled` | `true` / `false` | Whether fetched prompt content is cached to disk |
| `content_cache.path` | path string | Where to store the cache |
| `sdk_bridge.enabled` | `true` / `false` | Whether `--content` fetching is active |
| `deployment_mode` | `auto` / `single_user` / `server` | In `server` mode, content cache is disabled by default |

## Privacy and storage

This plugin stores data locally. Two locations matter:

- **Metrics database** (`~/.local/share/opencode-telemetry/data.db`): contains token counts, byte sizes, durations, session metadata. Never contains prompt content.
- **Content cache** (`~/.local/share/opencode-telemetry/content-cache/`): populated only when you run `octm inspect --content`. Caches the prompt content fetched via opencode SDK so re-running analyses is fast.

Disable the content cache persistently:

```bash
octm config set content_cache.enabled false
```

In server-mode opencode deployments, the content cache is disabled by default. No data is sent off your machine. There is no telemetry-of-the-telemetry.

## Known limitations

- **Subagent attribution** requires opencode to populate `Session.parentID` when spawning child sessions. This is structurally correct in v0.2 but cannot be empirically verified without a live Conductor session. If parent-child costs still show a discrepancy, check `docs/v0.2-investigation.md` for the diagnostic queries.
- **Token composition percentages** are byte-based (±15% on absolutes, <5% on ratios). For exact tokenizer counts use [Opencode-Context-Analysis-Plugin](https://github.com/IgorWarzocha/Opencode-Context-Analysis-Plugin).
- **`--content` requires opencode server** to be running. Without it, only cached content is available.
- **Server deployments**: content cache disabled by default for privacy.
- **No real-time export** — for streaming to observability backends, see [opencode-plugin-otel](https://github.com/DEVtheOPS/opencode-plugin-otel).

## Contributing

Issues and PRs welcome at [github.com/agostinilabsrl/opencode-telemetry](https://github.com/agostinilabsrl/opencode-telemetry).

## License

MIT
