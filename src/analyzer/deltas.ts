// Turn-to-turn delta analyzer.
// Computes how token consumption changed between consecutive turns and
// infers the likely cause from tool call sizes in the preceding turn.
import type { TurnComposition } from "./composition.ts";

export interface TurnWithComposition {
  turn_idx: number;
  total_tokens: number; // input + cached_read (what was in context)
  tool_calls: Array<{ tool_name: string; result_size_bytes: number | null }>;
  composition: TurnComposition | null;
}

export interface TurnDelta {
  turn_idx: number;
  delta_tokens: number;
  delta_pct: number;
  driver: keyof TurnComposition["breakdown_pct"] | "unknown";
  driver_growth_pct: number;
  likely_cause: string | null;
}

export function computeTurnDeltas(turns: TurnWithComposition[]): TurnDelta[] {
  const deltas: TurnDelta[] = [];

  for (let i = 1; i < turns.length; i++) {
    const prev = turns[i - 1];
    const curr = turns[i];

    const delta_tokens = curr.total_tokens - prev.total_tokens;
    const delta_pct =
      prev.total_tokens > 0
        ? Math.round((delta_tokens / prev.total_tokens) * 1000) / 10
        : 0;

    // Determine which composition category grew the most
    let driver: TurnDelta["driver"] = "unknown";
    let driver_growth_pct = 0;

    if (curr.composition && prev.composition) {
      const categories: Array<keyof TurnComposition["breakdown_pct"]> = [
        "system_prompt",
        "conversation_history",
        "tool_outputs",
        "user_message",
        "assistant_so_far",
      ];
      for (const cat of categories) {
        const growth = curr.composition.breakdown_pct[cat] - prev.composition.breakdown_pct[cat];
        if (growth > driver_growth_pct) {
          driver_growth_pct = growth;
          driver = cat;
        }
      }
    }

    // Infer likely cause from the largest tool result in the turn before
    let likely_cause: string | null = null;
    if (delta_tokens > 0 && prev.tool_calls.length > 0) {
      const largest = prev.tool_calls
        .filter(tc => tc.result_size_bytes != null)
        .sort((a, b) => (b.result_size_bytes ?? 0) - (a.result_size_bytes ?? 0))[0];
      if (largest && largest.result_size_bytes != null) {
        // Approximate: 1 token ≈ 4 bytes; check if result accounts for ≥50% of delta
        const resultTokenEstimate = Math.round(largest.result_size_bytes / 4);
        if (resultTokenEstimate >= delta_tokens * 0.5) {
          const kb = Math.round(largest.result_size_bytes / 1024);
          likely_cause = `${largest.tool_name} result ${kb}KB entered history`;
        }
      }
    }

    if (likely_cause === null && delta_tokens > 0) {
      likely_cause =
        driver !== "unknown"
          ? `${driver.replace(/_/g, " ")} growth (+${driver_growth_pct.toFixed(1)}%)`
          : "unidentified — manual review needed";
    }

    deltas.push({ turn_idx: curr.turn_idx, delta_tokens, delta_pct, driver, driver_growth_pct, likely_cause });
  }

  return deltas;
}

// Unicode block chart for token trajectory (scaled to max value in the set)
export function sparkline(values: number[], width = 5): string[] {
  const max = Math.max(...values, 1);
  const blocks = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
  return values.map(v => {
    const ratio = v / max;
    const idx = Math.min(Math.floor(ratio * blocks.length), blocks.length - 1);
    return ratio === 0 ? "▏" : blocks[idx];
  });
}
