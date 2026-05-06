import { describe, it, expect } from "bun:test";
import { analyzeComposition } from "../src/analyzer/composition.ts";
import type { MessageContent } from "../src/sdk-bridge.ts";

function msg(role: MessageContent["role"], content: string, toolResultBytes = 0): MessageContent {
  return {
    role,
    messageId: `msg-${Math.random()}`,
    content,
    byte_length: Buffer.byteLength(content, "utf8"),
    tool_calls: toolResultBytes > 0
      ? [{ tool_call_id: "tc1", tool_name: "bash", args: "{}", result: "x".repeat(toolResultBytes), byte_length: toolResultBytes }]
      : [],
  };
}

describe("analyzeComposition", () => {
  it("all-system scenario: single user message gets 100% system", () => {
    const messages: MessageContent[] = [msg("user", "system prompt here")];
    const result = analyzeComposition(messages, 1000);
    expect(result.breakdown_pct.system_prompt).toBe(100);
    expect(result.breakdown_pct.conversation_history).toBe(0);
    expect(result.total_tokens_provider).toBe(1000);
  });

  it("percentages sum to ~100%", () => {
    const messages: MessageContent[] = [
      msg("user", "system prompt"),
      msg("assistant", "first reply"),
      msg("user", "follow-up"),
      msg("assistant", "final reply"),
    ];
    const result = analyzeComposition(messages, 5000);
    const total = Object.values(result.breakdown_pct).reduce((s, v) => s + v, 0);
    // Allow ±2 due to rounding
    expect(total).toBeGreaterThan(98);
    expect(total).toBeLessThanOrEqual(102);
  });

  it("tool outputs are attributed separately", () => {
    const messages: MessageContent[] = [
      msg("user", "system"),
      msg("user", "run this", 5000), // 5KB tool output
      msg("assistant", "ok"),
    ];
    const result = analyzeComposition(messages, 2000);
    expect(result.breakdown_pct.tool_outputs).toBeGreaterThan(0);
  });

  it("estimated tokens are proportional to provider total", () => {
    const messages: MessageContent[] = [
      msg("user", "a".repeat(100)),
      msg("assistant", "b".repeat(100)),
    ];
    const result = analyzeComposition(messages, 1000);
    const estTotal = Object.values(result.breakdown_tokens_estimated).reduce((s, v) => s + v, 0);
    // Should be within rounding error of 1000
    expect(Math.abs(estTotal - 1000)).toBeLessThanOrEqual(10);
  });
});
