// Byte-based prompt composition analyzer.
// Principle: provider data is authoritative for token counts.
// We measure byte percentages only; absolute token estimates are labeled "≈".
import type { MessageContent } from "../sdk-bridge.ts";

export interface TurnComposition {
  total_bytes: number;
  // Provider-authoritative total tokens (from DB, not re-tokenized)
  total_tokens_provider: number;
  breakdown_pct: {
    system_prompt: number;
    conversation_history: number;
    tool_outputs: number;
    user_message: number;
    assistant_so_far: number;
  };
  // Proportional mapping of provider tokens to categories — labeled ≈ in output
  breakdown_tokens_estimated: {
    system_prompt: number;
    conversation_history: number;
    tool_outputs: number;
    user_message: number;
    assistant_so_far: number;
  };
}

export function analyzeComposition(
  messages: MessageContent[],
  totalTokensProvider: number
): TurnComposition {
  let systemBytes = 0;
  let historyBytes = 0;
  let toolOutputBytes = 0;
  let userMsgBytes = 0;
  let assistantBytes = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLast = i === messages.length - 1;

    if (msg.role === "user") {
      // First user message typically carries the system prompt in its `content`
      // (opencode prepends system prompt to the first user message's byte count)
      if (i === 0) {
        systemBytes += msg.byte_length;
      } else if (isLast) {
        userMsgBytes += msg.byte_length;
      } else {
        historyBytes += msg.byte_length;
      }
      // Tool outputs embedded in user messages
      for (const tc of msg.tool_calls) {
        toolOutputBytes += tc.byte_length;
      }
    } else if (msg.role === "assistant") {
      if (isLast) {
        assistantBytes += msg.byte_length;
      } else {
        historyBytes += msg.byte_length;
      }
      // Tool calls in assistant messages count as history
      for (const tc of msg.tool_calls) {
        historyBytes += tc.byte_length;
      }
    }
  }

  const total = systemBytes + historyBytes + toolOutputBytes + userMsgBytes + assistantBytes || 1;

  function pct(v: number): number {
    return Math.round((v / total) * 1000) / 10; // one decimal place
  }

  const bp = {
    system_prompt: pct(systemBytes),
    conversation_history: pct(historyBytes),
    tool_outputs: pct(toolOutputBytes),
    user_message: pct(userMsgBytes),
    assistant_so_far: pct(assistantBytes),
  };

  function estTok(p: number): number {
    return Math.round((p / 100) * totalTokensProvider);
  }

  return {
    total_bytes: total,
    total_tokens_provider: totalTokensProvider,
    breakdown_pct: bp,
    breakdown_tokens_estimated: {
      system_prompt: estTok(bp.system_prompt),
      conversation_history: estTok(bp.conversation_history),
      tool_outputs: estTok(bp.tool_outputs),
      user_message: estTok(bp.user_message),
      assistant_so_far: estTok(bp.assistant_so_far),
    },
  };
}
