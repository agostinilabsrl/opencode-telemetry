# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`opencode-telemetry` is an opencode plugin that passively logs per-turn telemetry (tokens, tool calls, skills, cost estimates) to a local SQLite database. It must never break or slow down the user's session, never log message bodies, and never make network calls.

## Runtime & Tooling

- **Runtime**: Bun (opencode runs on Bun) — use `bun:sqlite` (built-in, zero-dependency) over `better-sqlite3`
- **Language**: TypeScript
- **Package manager**: Bun (`bun install`, `bun run`)
- **Type check**: `bun tsc --noEmit`
- **Smoke test DB creation**: `bun run src/index.ts` then `sqlite3 ~/.local/share/opencode-telemetry/data.db ".schema"`

## Architecture

```
src/index.ts        — Plugin entry; subscribes to opencode events; exports default TelemetryPlugin
src/db.ts           — SQLite init (WAL, NORMAL sync), full schema DDL, cached prepared statements, exported write API
src/handlers.ts     — Event handlers (onSessionCreated, onMessageUpdated, onToolBefore, onToolAfter, onSessionIdle, onSessionDeleted)
src/pricing.ts      — Loads pricing.json, computes est_cost_usd per turn
src/pricing.json    — Static per-model token rates (input/output/cache_read/cache_write per MTok)
src/paths.ts        — Cross-platform DB path: $XDG_DATA_HOME or ~/.local/share on Linux/macOS, %LOCALAPPDATA% on Windows
src/types.ts        — TypeScript interfaces for events and internal state
command/            — Slash command .md definitions for /telemetry-report and /telemetry-inspect
queries/            — Standalone .sql files for direct sqlite3 CLI use
scripts/            — report.js and inspect.js that emit markdown tables for the slash commands
```

## Key Data Flow

1. opencode fires events → handlers extract metrics only (no message bodies, sizes as byte counts)
2. `onToolBefore` buffers pending calls in a `Map<string, PendingToolCall>` (keyed by tool call ID or `${sessionId}:${toolName}:${counter}`)
3. `onToolAfter` completes the row using the buffer, then inserts into `tool_calls`
4. `onMessageUpdated` dedupes via an in-memory `Set<string>` of logged message IDs; only records when `usage` is populated and `role === "assistant"`
5. `onSessionIdle` finalizes `sessions.ended_at` and recomputes aggregates from `turns` to self-heal drift

## Database

- Location: `~/.local/share/opencode-telemetry/data.db` (Linux/macOS default)
- Three main tables: `sessions`, `turns`, `tool_calls` — plus `_meta` for schema versioning
- All DDL uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` (idempotent)
- Pragmas set once at init: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`
- All writes are synchronous (bun:sqlite is sync) and wrapped in try/catch — errors emit `console.warn("[opencode-telemetry]", err)` and are swallowed

## Critical Implementation Notes (from §10 of SPEC.md)

Before implementing handlers, the spec mandates a **diagnostic pass**: run a minimal plugin that `console.log`s every event payload to discover actual field shapes. Any deviation from spec assumptions must be recorded in `NOTES.md`. Known uncertainties to verify:

- Does `message.updated` fire once at completion or on every stream chunk?
- Exact field names in `message.usage` (Anthropic uses `cache_read_input_tokens` / `cache_creation_input_tokens`)
- Skill tool arg schema (expected `{ name: "skill-id" }` but must verify)
- Parent-child session link field name in `session.created` payload
- Where `thinking_level` is exposed (may be `provider_metadata` or inferred from `reasoning_tokens > 0`)
- Whether there is an explicit `tool_call_id` for before/after correlation
- Correct field names on plugin context (`ctx.directory`, `ctx.worktree`)

## Design Constraints

- **Fail silent**: every handler is wrapped in try/catch; telemetry must never throw into the user's session
- **No message bodies**: only byte sizes, token counts, timings, and structural metadata
- **No network calls**: zero outbound requests
- **`est_cost_usd = NULL`** when model is not in pricing.json — never fabricate cost
- Target ~600–800 lines total; avoid over-engineering

## Pricing

`src/pricing.json` is a static snapshot. `est_cost_usd` per turn = `(input * input_rate + output * output_rate + cache_read * cache_read_rate + cache_write * cache_write_rate) / 1_000_000`. If model not found, return `null`. Session total is summed on `session.idle`.

## Schema Migration Convention

When adding a column or changing the schema:

1. Add a new entry to `MIGRATIONS[]` in `src/db.ts` with `version = <current_max + 1>`
2. In `up(db)`, use `PRAGMA table_info(<table>)` to check column existence **before** ALTER TABLE — never use bare `try/catch` around ALTER (silently swallowed errors can bump schema_version while leaving the column missing, which is unrecoverable)
3. Update `INSERT OR IGNORE INTO _meta VALUES ('schema_version', '<new_version>')` in the SCHEMA constant so fresh installs start at the new version
4. Include backfill queries if existing rows need to be populated
5. `runMigrations` runs on every plugin load, inside a transaction per migration — a real error stops the loop and logs a warning

## Development Branch

All changes go to branch `claude/implement-specs-notes-VhWmW`.
