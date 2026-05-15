import { describe, it, expect } from "bun:test";
import { weightedDistribution } from "../src/analyzer/distribution.ts";
import type { TurnDistributionInput } from "../src/analyzer/distribution.ts";
import { analyzeComposition } from "../src/analyzer/composition.ts";
import type { MessageContent } from "../src/sdk-bridge.ts";

function msg(role: MessageContent["role"], content: string, toolResultBytes = 0): MessageContent {
  return {
    role,
    messageId: `msg-${Math.random()}`,
    content,
    byte_length: Buffer.byteLength(content, "utf8"),
    tool_calls:
      toolResultBytes > 0
        ? [
            {
              tool_call_id: "tc1",
              tool_name: "bash",
              args: "{}",
              result: "x".repeat(toolResultBytes),
              byte_length: toolResultBytes,
            },
          ]
        : [],
  };
}

describe("weightedDistribution", () => {
  it("empty array → all zeros, coverage_pct 0", () => {
    const result = weightedDistribution([]);
    expect(result.system_prompt).toBe(0);
    expect(result.conversation_history).toBe(0);
    expect(result.tool_outputs).toBe(0);
    expect(result.user_message).toBe(0);
    expect(result.covered_turns).toBe(0);
    expect(result.total_turns).toBe(0);
    expect(result.coverage_pct).toBe(0);
  });

  it("single entry with composition → percentages sum to ~100%", () => {
    const messages: MessageContent[] = [
      msg("user", "system prompt here"),
      msg("assistant", "assistant reply"),
      msg("user", "user follow-up"),
    ];
    const comp = analyzeComposition(messages, 1000);
    const inputs: TurnDistributionInput[] = [{ composition: comp, total_input_tokens: 1000 }];
    const result = weightedDistribution(inputs);

    // coverage
    expect(result.covered_turns).toBe(1);
    expect(result.total_turns).toBe(1);
    expect(result.coverage_pct).toBe(100);

    // percentages sum to ~100 (allow ±2 for rounding)
    const total = result.system_prompt + result.conversation_history + result.tool_outputs + result.user_message;
    expect(total).toBeGreaterThan(98);
    expect(total).toBeLessThanOrEqual(102);
  });

  it("entry with null composition → does not contribute to pct but lowers coverage_pct", () => {
    const messages: MessageContent[] = [
      msg("user", "system"),
      msg("assistant", "reply"),
      msg("user", "follow-up"),
    ];
    const comp = analyzeComposition(messages, 1000);
    const inputs: TurnDistributionInput[] = [
      { composition: comp, total_input_tokens: 1000 },
      { composition: null, total_input_tokens: 1000 },
    ];
    const result = weightedDistribution(inputs);

    expect(result.covered_turns).toBe(1);
    expect(result.total_turns).toBe(2);
    // covered weight = 1000, total weight = 2000 → 50%
    expect(result.coverage_pct).toBe(50);

    // pct should still come from the covered turn
    const total = result.system_prompt + result.conversation_history + result.tool_outputs + result.user_message;
    expect(total).toBeGreaterThan(98);
    expect(total).toBeLessThanOrEqual(102);
  });

  it("weighting: large turn dominates over small turn", () => {
    // Two messages: big one is all system prompt, small one is all user message
    const bigMessages: MessageContent[] = [msg("user", "a".repeat(9000))];
    const smallMessages: MessageContent[] = [
      msg("user", "b".repeat(100)),
      msg("assistant", "c".repeat(100)),
      msg("user", "d".repeat(800)),
    ];

    const bigComp = analyzeComposition(bigMessages, 9000);
    const smallComp = analyzeComposition(smallMessages, 1000);

    const inputs: TurnDistributionInput[] = [
      { composition: bigComp, total_input_tokens: 9000 },
      { composition: smallComp, total_input_tokens: 1000 },
    ];
    const result = weightedDistribution(inputs);

    // The big turn (9000 tokens) is 100% system prompt, so system_prompt should dominate
    // The small turn contributes less weight
    expect(result.system_prompt).toBeGreaterThan(50);
  });

  it("assistant_so_far is excluded from re-normalisation — percentages still sum to ~100%", () => {
    // Large assistant reply → assistant_so_far gets a big share of raw breakdown_pct.
    // After re-normalisation (excluding assistant_so_far from denominator) the 4 context
    // buckets must still sum to ~100%, not be deflated by the assistant share.
    const messages: MessageContent[] = [
      msg("user", "system prompt"),
      msg("assistant", "long assistant reply " + "x".repeat(500)),
      msg("user", "new question"),
      msg("assistant", "in-progress reply"),
    ];
    const comp = analyzeComposition(messages, 2000);
    expect(comp.breakdown_pct.assistant_so_far).toBeGreaterThan(0);

    const inputs: TurnDistributionInput[] = [{ composition: comp, total_input_tokens: 2000 }];
    const result = weightedDistribution(inputs);

    const total = result.system_prompt + result.conversation_history + result.tool_outputs + result.user_message;
    expect(total).toBeGreaterThan(98);
    expect(total).toBeLessThanOrEqual(102);
  });
});
