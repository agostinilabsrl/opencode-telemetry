import { describe, it, expect, spyOn } from "bun:test";
import { createHandlers } from "../src/handlers.ts";
import type { DbHandle } from "../src/db.ts";
import type { TurnRow, ToolCallRow } from "../src/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

type CallLog = Record<string, unknown[][]>;

function makeMockDb(): DbHandle & { calls: CallLog } {
  const calls: CallLog = {};
  function track(name: string, ...args: unknown[]) {
    (calls[name] ??= []).push(args);
  }
  return {
    calls,
    insertTurn: (row: TurnRow) => track("insertTurn", row),
    upsertSession: (f) => track("upsertSession", f),
    updatePrimaryAgent: (sid, agent) => track("updatePrimaryAgent", sid, agent),
    incrementSessionTurns: (...args) => track("incrementSessionTurns", ...args),
    insertToolCall: (row: ToolCallRow) => track("insertToolCall", row),
    incrementSessionToolCalls: (sid) => track("incrementSessionToolCalls", sid),
    finalizeSession: (sid) => track("finalizeSession", sid),
    linkOrphanToolCalls: (...args) => track("linkOrphanToolCalls", ...args),
    getMaxTurnIdx: () => -1,
    schemaVersion: () => 2,
    getServerUrl: () => null,
    close: () => {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCtx: any = { directory: "/project", worktree: null, serverUrl: null };

function sessionCreatedEvent(id: string, parentID?: string) {
  return {
    type: "session.created",
    properties: { info: { id, parentID, time: { created: Date.now() }, directory: "/project" } },
  } as unknown;
}

function userMsgEvent(sessionID: string, agent: string) {
  return {
    type: "message.updated",
    properties: {
      info: {
        id: `user-${Math.random()}`,
        sessionID,
        role: "user",
        agent,
        time: { created: Date.now() },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  } as unknown;
}

function assistantMsgEvent(msgId: string, sessionID: string, opts: { completed?: boolean; reasoning?: number } = {}) {
  const created = Date.now() - 500;
  return {
    type: "message.updated",
    properties: {
      info: {
        id: msgId,
        sessionID,
        role: "assistant",
        time: { created, completed: opts.completed !== false ? created + 500 : undefined },
        tokens: {
          input: 100,
          output: 50,
          reasoning: opts.reasoning ?? 0,
          cache: { read: 10, write: 5 },
        },
        modelID: "claude-sonnet-4-6",
        providerID: "anthropic",
        mode: "default",
        finish: "end_turn",
      },
    },
  } as unknown;
}

function sessionIdleEvent(sessionID: string) {
  return { type: "session.idle", properties: { sessionID } } as unknown;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("onEvent — session.created", () => {
  it("inserts a session row on creation", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-1") } as never);
    expect(db.calls["upsertSession"]).toHaveLength(1);
    const fields = db.calls["upsertSession"][0][0] as { session_id: string; parent_session_id: null };
    expect(fields.session_id).toBe("sess-1");
    expect(fields.parent_session_id).toBeNull();
  });

  it("maps parentID to parent_session_id", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("child", "parent-123") } as never);
    const fields = db.calls["upsertSession"][0][0] as { parent_session_id: string };
    expect(fields.parent_session_id).toBe("parent-123");
  });
});

describe("onEvent — message.updated (user)", () => {
  it("caches agent and calls updatePrimaryAgent, does not insert a turn", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-2") } as never);
    await onEvent({ event: userMsgEvent("sess-2", "my-agent") } as never);
    expect(db.calls["updatePrimaryAgent"]).toHaveLength(1);
    expect(db.calls["insertTurn"]).toBeUndefined();
  });
});

describe("onEvent — message.updated (assistant)", () => {
  it("skips messages without time.completed", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-3") } as never);
    await onEvent({ event: assistantMsgEvent("msg-1", "sess-3", { completed: false }) } as never);
    expect(db.calls["insertTurn"]).toBeUndefined();
  });

  it("inserts a turn for a completed assistant message", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-4") } as never);
    await onEvent({ event: assistantMsgEvent("msg-2", "sess-4") } as never);
    expect(db.calls["insertTurn"]).toHaveLength(1);
    const row = db.calls["insertTurn"][0][0] as TurnRow;
    expect(row.session_id).toBe("sess-4");
    expect(row.turn_idx).toBe(0);
    expect(row.model).toBe("claude-sonnet-4-6");
  });

  it("deduplicates: same message ID fires twice, only one turn inserted", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-5") } as never);
    const evt = assistantMsgEvent("msg-dup", "sess-5");
    await onEvent({ event: evt } as never);
    await onEvent({ event: evt } as never);
    expect(db.calls["insertTurn"]).toHaveLength(1);
  });

  it("assigns sequential turn_idx across messages", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-6") } as never);
    await onEvent({ event: assistantMsgEvent("msg-a", "sess-6") } as never);
    await onEvent({ event: assistantMsgEvent("msg-b", "sess-6") } as never);
    const rows = db.calls["insertTurn"].map(c => (c[0] as TurnRow).turn_idx);
    expect(rows).toEqual([0, 1]);
  });

  it("sets thinking_level=active when reasoning tokens > 0", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-7") } as never);
    await onEvent({ event: assistantMsgEvent("msg-think", "sess-7", { reasoning: 200 }) } as never);
    const row = db.calls["insertTurn"][0][0] as TurnRow;
    expect(row.thinking_level).toBe("active");
  });

  it("calls linkOrphanToolCalls after inserting a turn", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionCreatedEvent("sess-8") } as never);
    await onEvent({ event: assistantMsgEvent("msg-3", "sess-8") } as never);
    expect(db.calls["linkOrphanToolCalls"]).toHaveLength(1);
    const [sid, tidx] = db.calls["linkOrphanToolCalls"][0] as [string, number];
    expect(sid).toBe("sess-8");
    expect(tidx).toBe(0);
  });
});

describe("onEvent — session.idle", () => {
  it("calls finalizeSession", async () => {
    const db = makeMockDb();
    const { onEvent } = createHandlers(db, mockCtx);
    await onEvent({ event: sessionIdleEvent("sess-9") } as never);
    expect(db.calls["finalizeSession"]).toHaveLength(1);
    expect(db.calls["finalizeSession"][0][0]).toBe("sess-9");
  });
});

describe("onToolBefore + onToolAfter", () => {
  it("records a tool call with duration when before+after fire with matching callID", async () => {
    const db = makeMockDb();
    const { onToolBefore, onToolAfter } = createHandlers(db, mockCtx);

    await onToolBefore(
      { tool: "bash", sessionID: "sess-10", callID: "call-1" },
      { args: { cmd: "ls" } }
    );
    await onToolAfter(
      { tool: "bash", sessionID: "sess-10", callID: "call-1", args: { cmd: "ls" } },
      { title: "ls", output: "file1\nfile2", metadata: null }
    );

    expect(db.calls["insertToolCall"]).toHaveLength(1);
    const row = db.calls["insertToolCall"][0][0] as ToolCallRow;
    expect(row.tool_name).toBe("bash");
    expect(row.session_id).toBe("sess-10");
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
    expect(row.status).toBe("ok");
  });

  it("records tool call with null duration when onToolAfter fires without matching before", async () => {
    const db = makeMockDb();
    const { onToolAfter } = createHandlers(db, mockCtx);

    await onToolAfter(
      { tool: "read_file", sessionID: "sess-11", callID: "orphan-call", args: {} },
      { title: "read", output: "content", metadata: null }
    );

    expect(db.calls["insertToolCall"]).toHaveLength(1);
    const row = db.calls["insertToolCall"][0][0] as ToolCallRow;
    expect(row.duration_ms).toBeNull();
  });

  it("extracts skill_name from args when tool is 'skill'", async () => {
    const db = makeMockDb();
    const { onToolBefore, onToolAfter } = createHandlers(db, mockCtx);

    await onToolBefore(
      { tool: "skill", sessionID: "sess-12", callID: "call-skill" },
      { args: { name: "my-skill-id" } }
    );
    await onToolAfter(
      { tool: "skill", sessionID: "sess-12", callID: "call-skill", args: { name: "my-skill-id" } },
      { title: "skill", output: "", metadata: null }
    );

    const row = db.calls["insertToolCall"][0][0] as ToolCallRow;
    expect(row.skill_name).toBe("my-skill-id");
  });

  it("sets status=error when metadata has error flag", async () => {
    const db = makeMockDb();
    const { onToolAfter } = createHandlers(db, mockCtx);

    await onToolAfter(
      { tool: "bash", sessionID: "sess-13", callID: "err-call", args: {} },
      { title: "bash", output: "", metadata: { error: "command failed" } }
    );

    const row = db.calls["insertToolCall"][0][0] as ToolCallRow;
    expect(row.status).toBe("error");
    expect(row.error_message).toContain("command failed");
  });
});

describe("fail-silent", () => {
  it("does not throw when db.insertTurn throws", async () => {
    const db = makeMockDb();
    db.insertTurn = () => { throw new Error("DB write failed"); };
    const { onEvent } = createHandlers(db, mockCtx);

    // Should not throw
    await onEvent({ event: sessionCreatedEvent("sess-14") } as never);
    await expect(onEvent({ event: assistantMsgEvent("msg-x", "sess-14") } as never)).resolves.toBeUndefined();
  });

  it("does not throw when db.insertToolCall throws", async () => {
    const db = makeMockDb();
    db.insertToolCall = () => { throw new Error("DB write failed"); };
    const { onToolAfter } = createHandlers(db, mockCtx);

    await expect(
      onToolAfter(
        { tool: "bash", sessionID: "sess-15", callID: "c1", args: {} },
        { title: "", output: "", metadata: null }
      )
    ).resolves.toBeUndefined();
  });
});
