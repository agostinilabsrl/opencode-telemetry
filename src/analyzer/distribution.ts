import type { TurnComposition } from "./composition.ts";

export interface ContextDistribution {
  system_prompt: number;
  conversation_history: number;
  tool_outputs: number;
  user_message: number;
  covered_turns: number;
  total_turns: number;
  coverage_pct: number;
}

export interface TurnDistributionInput {
  composition: TurnComposition | null;
  total_input_tokens: number;
}

export function weightedDistribution(turns: TurnDistributionInput[]): ContextDistribution {
  let sumSys = 0, sumHist = 0, sumTools = 0, sumInput = 0;
  let coveredWeight = 0, totalWeight = 0, coveredTurns = 0;

  for (const { composition, total_input_tokens } of turns) {
    const tok = total_input_tokens ?? 0;
    totalWeight += tok;
    if (!composition) continue;
    const bp = composition.breakdown_pct;
    const contextSum = bp.system_prompt + bp.conversation_history + bp.tool_outputs + bp.user_message;
    if (contextSum === 0) continue;
    sumSys   += (bp.system_prompt        / contextSum) * tok;
    sumHist  += (bp.conversation_history / contextSum) * tok;
    sumTools += (bp.tool_outputs          / contextSum) * tok;
    sumInput += (bp.user_message          / contextSum) * tok;
    coveredWeight += tok;
    coveredTurns++;
  }

  const denom = coveredWeight || 1;
  const r = (v: number) => Math.round((v / denom) * 1000) / 10;
  return {
    system_prompt:        r(sumSys),
    conversation_history: r(sumHist),
    tool_outputs:         r(sumTools),
    user_message:         r(sumInput),
    covered_turns: coveredTurns,
    total_turns:   turns.length,
    coverage_pct:  totalWeight > 0 ? Math.round((coveredWeight / totalWeight) * 100) : 0,
  };
}
