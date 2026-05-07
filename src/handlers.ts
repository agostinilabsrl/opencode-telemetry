import type { Event } from "@opencode-ai/sdk";
import type { PluginInput } from "@opencode-ai/plugin";
import type { DbHandle } from "./db.ts";
import { estimateCost } from "./pricing.ts";

type PendingToolCall = {
  session_id: string;
  turn_idx: number;
  tool_name: string;
  skill_name: string | null;
  tool_call_id: string | null;
  args_size_bytes: number | null;
  start_time: number;
  created_at: string;
};

export function createHandlers(db: DbHandle, ctx: PluginInput) {
  // In-memory state per plugin process
  const seenMessageIds = new Set<string>();
  const sessionTurnCounters = new Map<string, number>();
  // sessionID -> most recent agent seen from UserMessage
  const sessionCurrentAgent = new Map<string, string>();
  // callID -> pending tool call metadata
  const pendingToolCalls = new Map<string, PendingToolCall>();
  // Capture server URL once (from ctx.serverUrl if available)
  const serverUrl: string | null = ctx.serverUrl ? String(ctx.serverUrl) : null;

  function peekCurrentTurnIdx(sessionId: string): number {
    if (!sessionTurnCounters.has(sessionId)) {
      const max = db.getMaxTurnIdx(sessionId);
      sessionTurnCounters.set(sessionId, max + 1);
    }
    return sessionTurnCounters.get(sessionId)!;
  }

  function getNextTurnIdx(sessionId: string): number {
    if (!sessionTurnCounters.has(sessionId)) {
      // Seed from DB on first use to survive process restarts
      const max = db.getMaxTurnIdx(sessionId);
      sessionTurnCounters.set(sessionId, max + 1);
    }
    const idx = sessionTurnCounters.get(sessionId)!;
    sessionTurnCounters.set(sessionId, idx + 1);
    return idx;
  }

  async function onEvent({ event }: { event: Event }): Promise<void> {
    try {
      if (event.type === "session.created") {
        const s = event.properties.info;
        db.upsertSession({
          session_id: s.id,
          // NOTE: Session.parentID used (not parent_session_id — see NOTES.md)
          parent_session_id: s.parentID ?? null,
          started_at: new Date(s.time.created).toISOString(),
          // NOTE: Session.directory is the cwd; worktree comes from plugin ctx
          project_path: s.directory ?? ctx.directory ?? null,
          worktree_path: ctx.worktree ?? null,
          primary_agent: null,
          server_url: serverUrl,
        });
      } else if (event.type === "message.updated") {
        const msg = event.properties.info;
        if (msg.role === "user") {
          // Cache agent for this session from user messages
          if (msg.agent) {
            sessionCurrentAgent.set(msg.sessionID, msg.agent);
            // Set primary_agent on the session (only if not already set — idempotent)
            db.updatePrimaryAgent(msg.sessionID, msg.agent);
          }
          return;
        }
        // AssistantMessage from here
        if (seenMessageIds.has(msg.id)) return;
        // NOTE: Terminal detection uses time.completed (not a 'usage' field — see NOTES.md)
        if (!msg.time.completed) return;

        seenMessageIds.add(msg.id);

        const agent = sessionCurrentAgent.get(msg.sessionID) ?? null;
        const turn_idx = getNextTurnIdx(msg.sessionID);

        // NOTE: thinking_level inferred from reasoning > 0 or mode field (see NOTES.md)
        let thinkingLevel: string | null = null;
        if (msg.tokens.reasoning > 0) {
          thinkingLevel = "active";
        } else if (msg.mode && msg.mode !== "default") {
          thinkingLevel = msg.mode;
        }

        const cost = estimateCost(msg.providerID, msg.modelID, {
          input: msg.tokens.input,
          output: msg.tokens.output,
          cacheRead: msg.tokens.cache.read,
          cacheWrite: msg.tokens.cache.write,
        });

        db.insertTurn({
          session_id: msg.sessionID,
          turn_idx,
          message_id: msg.id,
          parent_tool_call_id: null, // populated post-hoc via spawned_session_id linkage
          agent,
          model: msg.modelID ?? null,
          provider_id: msg.providerID ?? null,
          thinking_level: thinkingLevel,
          input_tokens: msg.tokens.input,
          output_tokens: msg.tokens.output,
          cached_read_tokens: msg.tokens.cache.read,
          cached_write_tokens: msg.tokens.cache.write,
          reasoning_tokens: msg.tokens.reasoning > 0 ? msg.tokens.reasoning : null,
          latency_ms: Math.round(msg.time.completed - msg.time.created),
          finish_reason: msg.finish ?? null,
          created_at: new Date(msg.time.created).toISOString(),
        });

        db.incrementSessionTurns(
          msg.sessionID,
          cost,
          msg.tokens.input,
          msg.tokens.output,
          msg.tokens.cache.read,
          msg.tokens.cache.write,
          msg.tokens.reasoning,
        );
      } else if (event.type === "session.idle") {
        db.finalizeSession(event.properties.sessionID);
      }
      // session.deleted intentionally not handled — we keep historical data
    } catch (err) {
      console.warn("[opencode-telemetry] event handler error:", err);
    }
  }

  async function onToolBefore(
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown }
  ): Promise<void> {
    try {
      // NOTE: skill arg key is "name" based on @opencode-ai/plugin types (see NOTES.md)
      const skillName =
        input.tool === "skill"
          ? ((output.args as Record<string, unknown>)?.name as string | null) ?? null
          : null;

      pendingToolCalls.set(input.callID, {
        session_id: input.sessionID,
        turn_idx: peekCurrentTurnIdx(input.sessionID),
        tool_name: input.tool,
        skill_name: skillName,
        tool_call_id: input.callID ?? null,
        args_size_bytes: safeByteLen(output.args),
        start_time: Date.now(),
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("[opencode-telemetry] tool.before error:", err);
    }
  }

  async function onToolAfter(
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ): Promise<void> {
    try {
      const pending = pendingToolCalls.get(input.callID);
      pendingToolCalls.delete(input.callID);

      const duration_ms = pending ? Date.now() - pending.start_time : null;

      // Detect errors: check metadata for an error flag — exact shape not confirmed (see NOTES.md).
      const meta = output.metadata as Record<string, unknown> | null;
      const isError = !!(meta?.error || meta?.isError);

      db.insertToolCall({
        session_id: input.sessionID,
        turn_idx: pending?.turn_idx ?? null,
        tool_name: input.tool,
        skill_name:
          pending?.skill_name ??
          (input.tool === "skill"
            ? ((input.args as Record<string, unknown>)?.name as string | null) ?? null
            : null),
        tool_call_id: input.callID ?? null,
        spawned_session_id: null, // populated if opencode surfaces child session ID in result metadata
        args_size_bytes: pending?.args_size_bytes ?? safeByteLen(input.args),
        result_size_bytes: safeByteLen(output.output),
        duration_ms,
        status: isError ? "error" : "ok",
        error_message: isError
          ? String(meta?.error ?? meta?.isError ?? "").slice(0, 500)
          : null,
        created_at: pending?.created_at ?? new Date().toISOString(),
      });

      db.incrementSessionToolCalls(input.sessionID);
    } catch (err) {
      console.warn("[opencode-telemetry] tool.after error:", err);
    }
  }

  return { onEvent, onToolBefore, onToolAfter };
}

function safeByteLen(value: unknown): number | null {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return null;
  }
}
