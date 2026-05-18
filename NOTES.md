# NOTES.md — Deviations from SPEC.md

This file documents every place where implementation differs from the assumptions in `SPEC.md §10`.
Verified against `@opencode-ai/plugin@1.14.28` and `@opencode-ai/sdk` (installed April 2026).

---

## 1. Plugin hook structure is different from spec

**Spec assumed**: separate named hooks `session.created`, `message.updated`, `session.idle`, `session.deleted` returned from the plugin function.

**Actual API** (`node_modules/@opencode-ai/plugin/dist/index.d.ts`):
- There is **one generic `event` hook** that receives all events as `{ event: Event }`.
- `tool.execute.before` and `tool.execute.after` are dedicated hooks (spec was correct on these).

**Implementation**: The plugin returns `{ event, "tool.execute.before", "tool.execute.after" }`. The `event` handler switches on `event.type` to dispatch to session/message logic.

---

## 2. `message.updated` fires on streaming chunks AND at completion

**Spec assumed**: event fires "multiple times per message as it streams"; terminal update detectable via presence of `usage`.

**Actual**: `AssistantMessage` has no `usage` field. Token counts live directly on the message:
```ts
tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
```
These fields are **always present** (even as zeros during streaming), so `usage` presence cannot be used as a terminal signal.

**Implementation**: Terminal detection uses `time.completed` being set (only present on the final event for a message). Messages with no `time.completed` are skipped. An in-memory `Set<string>` of seen message IDs prevents double-recording.

---

## 3. Token field names differ from spec

**Spec assumed**: `cache_read_input_tokens` / `cache_creation_input_tokens` (Anthropic SDK names).

**Actual** (opencode normalises them):
| Spec name | Actual path on AssistantMessage |
|---|---|
| `input_tokens` | `tokens.input` |
| `output_tokens` | `tokens.output` |
| `cache_read_input_tokens` | `tokens.cache.read` |
| `cache_creation_input_tokens` | `tokens.cache.write` |
| `reasoning_tokens` | `tokens.reasoning` |

opencode re-exposes them in a provider-neutral shape — no need to handle Anthropic-specific key names.

---

## 4. `agent` is not on `AssistantMessage`

**Spec assumed**: `agent` is extractable from `message.updated` payload.

**Actual**: `AssistantMessage` has `modelID`, `providerID`, `cost`, `tokens`, `finish`, `mode` — but **no `agent` field**.

`UserMessage` does have `agent: string`.

**Implementation**: When a `message.updated` event fires with `role === "user"`, the agent name is cached in `sessionCurrentAgent: Map<sessionID, string>`. When an assistant message fires, the cached value is looked up. This works because user messages always precede their assistant responses.

---

## 5. `thinking_level` has no dedicated field

**Spec assumed**: `thinking_level` may be in `provider_metadata` or `model_options`.

**Actual**: Neither exists on `AssistantMessage`. The closest signals are:
- `tokens.reasoning > 0` — reasoning tokens were used (thinking was active).
- `mode: string` — opencode sets this field; known values include `"default"` (and possibly `"think"` for thinking-enabled runs, unconfirmed).

**Implementation**: `thinking_level` is set to `"active"` when `reasoning > 0`, or to the raw `mode` value when it differs from `"default"`. Otherwise `NULL`. This is best-effort.

---

## 6. `Session.parentID` not `parent_session_id`

**Spec assumed**: parent session link field might be `parentId`, `parent_session_id`, or nested in metadata.

**Actual** (`Session` type):
```ts
parentID?: string
```

**Implementation**: `session.parentID` is mapped to the `parent_session_id` column.

---

## 7. `worktree_path` is not on the `Session` object

**Spec assumed**: `worktree_path` comes from `session.created`.

**Actual**: `Session` only has `directory` (cwd). Worktree path is not in the event payload.

**Implementation**: `worktree_path` is populated from `ctx.worktree` (the `PluginInput` passed at plugin init time), which is the plugin context's worktree path. It is the same value for all sessions handled by this plugin process.

---

## 8. `session.idle` payload has only `sessionID`

**Spec assumed**: might carry additional metadata.

**Actual**:
```ts
EventSessionIdle = { type: "session.idle"; properties: { sessionID: string } }
```

**Implementation**: On idle, `finalizeSession(sessionID)` is called, which sets `ended_at` and recomputes all aggregate totals from the `turns` and `tool_calls` tables (self-healing any drift from incremental updates).

---

## 9. `tool.execute.before` args are in `output.args`, not `input`

**Spec assumed**: args available on `tool.execute.before`.

**Actual** (verified from plugin type):
```ts
"tool.execute.before": (input: { tool, sessionID, callID }, output: { args }) => Promise<void>
```
Args are in `output.args` (mutable, so plugins could modify them), not on `input`.

**Implementation**: `args_size_bytes` computed from `output.args` in `onToolBefore`. The `callID` in `input` is used as the key for the pending-tool-call buffer — correlation confirmed available.

---

## 10. `tool.execute.after` result is `output.output: string`, not a structured object

**Spec assumed**: result has an error flag in metadata or a dedicated error field.

**Actual**:
```ts
"tool.execute.after": (input: { tool, sessionID, callID, args }, output: { title, output, metadata }) => Promise<void>
```
`output.output` is a plain string. `output.metadata` shape is `unknown`.

**Implementation**: `result_size_bytes = Buffer.byteLength(JSON.stringify(output.output))`. Error detection checks `output.metadata?.error || output.metadata?.isError` (best-effort; exact shape unconfirmed at implementation time — stored as `"ok"` if neither flag is set).

---

## 11. `turn_idx` correlation: primary path + post-hoc fallback

**Spec assumed**: tool calls could be linked to their originating turn.

**Actual**: Tool `before`/`after` events fire before (or concurrently with) the `message.updated` event that records the turn. There is no shared turn ID in the tool payloads.

**Implementation (two-tier)**:

1. **Primary** — `onToolBefore` stores the pending call in `pendingToolCalls` keyed by `callID`, capturing `turn_idx = peekCurrentTurnIdx(sessionID)` at that moment. `onToolAfter` looks up the pending entry by `callID` and writes `pending.turn_idx`. This covers the normal case where `callID` matches.

2. **Post-hoc fallback** — After `insertTurn` in `onMessageUpdated`, `db.linkOrphanToolCalls(sessionID, turn_idx, window_start, window_end)` issues an `UPDATE tool_calls SET turn_idx = ? WHERE turn_idx IS NULL AND created_at BETWEEN ? AND ?`. The window is `[msg.time.created, msg.time.completed + 100ms]`. This fixes any rows left with `NULL` due to `callID` mismatches or other edge cases.

**Residual gap**: tool calls that fired after `msg.time.completed` (e.g. a slow `onToolAfter` race) will remain unlinked. Empirically unlikely; documented as acceptable.

---

## 12. Plugin module export shape

**Spec assumed**: `export default TelemetryPlugin`.

**Actual** (`PluginModule` type):
```ts
type PluginModule = { id?: string; server: Plugin; tui?: never }
```
opencode loads the module's `server` named export.

**Implementation**: Both `export const server = TelemetryPlugin` and `export default TelemetryPlugin` are present for compatibility.

---

## 13. `better-sqlite3` not used — `bun:sqlite` used throughout

Per spec §5.2 preference: `bun:sqlite` (built-in, zero external dependency) was used from the start. `better-sqlite3` is not in `dependencies`. The `package.json` has no runtime dependencies at all.

---

## 14. Slash command Node fallback was broken at initial implementation

**Spec assumed** (§6.1/6.2): a `scripts/report.js` / `scripts/inspect.js` would be available as a Node fallback in the published package.

**Initial implementation drift**: the scripts were written as `.ts` files using `bun:sqlite` and run directly with `bun run`. The 3-tier fallback chain in the `.md` command files referenced `.js` files, but those files were never built or published — `tsconfig.json` has `"noEmit": true` and no bundler was configured. On machines without Bun in `PATH`, the fallback ran `node .../report.js`, which failed with `Cannot find module`.

**Fix (issue #12)**: three changes were made together:

1. **`scripts/db-compat.ts`** — a new cross-runtime SQLite adapter. Uses `createRequire` from `node:module` (available in both Bun and Node) for synchronous module loading:
   - In Bun (`typeof Bun !== "undefined"`): loads `bun:sqlite` and returns its `Database` directly (already has `.query(sql).all(params)` and `.close()`).
   - In Node ≥ 22.5: loads `node:sqlite`'s `DatabaseSync` and wraps it to expose the same `.query(sql).all(params)` interface.
   - Named-parameter objects (`{ $id: value }`) work identically in both runtimes.

2. **`scripts/report.ts` and `scripts/inspect.ts`** — replaced `import { Database } from "bun:sqlite"` with `import { openDatabase } from "./db-compat.ts"`. The `q()` helper and all query calls are unchanged.

3. **Build step** — `package.json` now has:
   ```
   "build:scripts": "bun build scripts/report.ts scripts/inspect.ts --target=node --external bun:sqlite --outdir=scripts"
   "prepublishOnly": "bun run build:scripts"
   ```
   `--external bun:sqlite` prevents the bundler from trying to resolve the Bun-only module. In the bundled output, `require("bun:sqlite")` only appears inside the `typeof Bun !== "undefined"` branch, so it is never executed under Node. The produced `scripts/report.js` and `scripts/inspect.js` are included in the npm package (via the existing `"scripts/"` entry in `files`) but excluded from git (added to `.gitignore`).

**Runtime requirement for Node fallback**: Node ≥ 22.5 (first stable release with `node:sqlite` built in). No external dependencies are added. The plugin core (`src/`) continues to use `bun:sqlite` exclusively and is unaffected.

---

## 15. Skill arg key — defensive multi-key extraction (#42)

**Original assumption**: skill tool args always carry `{ name: "skill-id" }` — the `name` key.

**Status**: The `name` key has not been observed to change in the wild, but the arg shape is not part of a stable public API contract. A regression was identified where a future opencode version could rename this field (e.g. to `skillName`, `id`, or `skill`), silently causing all skill tool calls to be stored with `skill_name = NULL`.

**Fix**: `extractSkillName(args)` in `src/handlers.ts` tries keys in priority order: `name → skillName → id → skill`. This is used in both `onToolBefore` and `onToolAfter`. The first non-null string value is used. If none match, `NULL` is stored (same as before, but without silent data loss when the key changes).

**Evidence of actual key change**: None observed as of 2026-05-15. This is a proactive defensive fix.

---

## 17. Migration v2 bare-try/catch — bug class and fix (issue #44)

**Bug**: Migration v2 (shipped in v0.2.0) used bare `try/catch` around each `ALTER TABLE`
statement, assuming any exception meant "column already exists". If an ALTER failed for any
other reason, the error was swallowed but the transaction still committed `schema_version=2`.
Result: columns missing, DB in unrecoverable state, no subsequent migration to repair it.

**Affected columns** (all added in migration v2 via bare try/catch):

| Column | Table | Recovery |
|--------|-------|----------|
| `slash_command` | `sessions` | migration v3 (PRAGMA check) |
| `server_url` | `sessions` | migration v4 (PRAGMA check) — manifested as crash in `report.ts` (issue #44) |
| `parent_tool_call_id` | `turns` | migration v5 (PRAGMA check) |
| `tool_call_id` | `tool_calls` | migration v5 (PRAGMA check) |
| `spawned_session_id` | `tool_calls` | migration v5 (PRAGMA check) |

**Root cause of the visible crash (issue #44)**: `report.ts` opens the DB readonly (no
migrations run at report time), queries `server_url` directly →
`SQLiteError: no such column: server_url`.

**Fix (three layers)**:
1. All v2 columns added to the base `CREATE TABLE` DDL in the SCHEMA constant — fresh installs
   get the correct schema from the start without relying on migrations.
2. Migrations v4 and v5 use `PRAGMA table_info` before each `ALTER TABLE` — any existing DB
   missing these columns is silently repaired on next plugin startup.
3. The `server_url` query in `report.ts` is wrapped in try/catch with env-var fallback —
   the report degrades gracefully even on a DB that has not yet been migrated.

**Rule**: see CLAUDE.md §Schema Migration Convention — always use `PRAGMA table_info` before
`ALTER TABLE`. Migration v2 is kept as-is (historical record) with a WARNING comment.

---

## 16. Subagent Attribution Verification Status (Phase 0 Investigation) [formerly §15]

**Question**: Is `parent_session_id` correctly captured when a Conductor session dispatches ACT/REVIEW subagents? A $2.63 vs ~$10 billing discrepancy suggests child costs may be invisible.

**Code-level findings** (verified 2026-05-06):

| Component | Status | Location |
|---|---|---|
| `Session.parentID?: string` exists in SDK type | ✓ Confirmed | `@opencode-ai/sdk/dist/gen/types.gen.d.ts:469` |
| Handler reads `s.parentID ?? null` | ✓ Confirmed | `src/handlers.ts:44` |
| Schema column `parent_session_id TEXT` with index | ✓ Confirmed | `src/db.ts:11, 30` |
| Inspector queries `WHERE parent_session_id = $id` | ✓ Confirmed | `scripts/inspect.ts:89` |
| Smoke test exercises parent-child round-trip | ✓ Added | `scripts/smoke.ts` |

**What remains unconfirmed**: Whether opencode *actually populates* `parentID` on the `Session` object when spawning subagent sessions. The field is optional in the SDK type (`parentID?: string`), meaning opencode may not set it. This can only be verified against a live Conductor session.

**How to verify empirically** (run once a real Conductor session exists in the DB):
```sql
-- Find a conductor session with at least 5 tool dispatches
SELECT session_id, primary_agent, total_turns, total_tool_calls, est_cost_usd
FROM sessions
WHERE primary_agent = 'conductor' AND total_tool_calls >= 5
ORDER BY est_cost_usd DESC LIMIT 5;

-- Check if children were recorded for one of those sessions
SELECT session_id, parent_session_id, primary_agent, total_turns, est_cost_usd
FROM sessions
WHERE parent_session_id = '<chosen_session_id>'
   OR session_id = '<chosen_session_id>'
ORDER BY started_at;
```

If no child rows appear (`parent_session_id` always NULL), opencode does not populate `parentID` and the attribution path is broken at the source. In that case, the fix would require correlating sessions via timestamp proximity or a new opencode event payload field.
