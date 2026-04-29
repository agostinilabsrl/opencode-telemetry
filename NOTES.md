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

## 11. `turn_idx` cannot be correlated with tool calls at call time

**Spec assumed**: tool calls could be linked to their originating turn.

**Actual**: Tool `before`/`after` events fire concurrently with (or before) the `message.updated` event that records the turn. There is no shared turn ID in the tool payloads.

**Implementation**: `tool_calls.turn_idx` is stored as `NULL`. Approximate correlation can be done post-hoc via timestamp proximity (`tool_calls.created_at` vs `turns.created_at`).

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
