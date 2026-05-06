import { describe, it, expect } from "bun:test";
import { computeTurnDeltas, sparkline } from "../src/analyzer/deltas.ts";
import type { TurnWithComposition } from "../src/analyzer/deltas.ts";

function turn(idx: number, total: number, resultBytes = 0): TurnWithComposition {
  return {
    turn_idx: idx,
    total_tokens: total,
    tool_calls: resultBytes > 0
      ? [{ tool_name: "bash", result_size_bytes: resultBytes }]
      : [],
    composition: null,
  };
}

describe("computeTurnDeltas", () => {
  it("returns empty array for single turn", () => {
    expect(computeTurnDeltas([turn(0, 1000)])).toHaveLength(0);
  });

  it("computes correct delta_tokens and delta_pct", () => {
    const turns = [turn(0, 1000), turn(1, 1500)];
    const deltas = computeTurnDeltas(turns);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].delta_tokens).toBe(500);
    expect(deltas[0].delta_pct).toBeCloseTo(50, 1);
  });

  it("negative delta is tracked correctly", () => {
    const turns = [turn(0, 2000), turn(1, 1500)];
    const deltas = computeTurnDeltas(turns);
    expect(deltas[0].delta_tokens).toBe(-500);
  });

  it("infers likely_cause from large tool result", () => {
    // A bash result of 40KB — ~10k token estimate — matching a 10k token delta
    const turns = [
      { ...turn(0, 10_000), tool_calls: [{ tool_name: "bash", result_size_bytes: 40_000 }] },
      turn(1, 20_000),
    ];
    const deltas = computeTurnDeltas(turns);
    expect(deltas[0].likely_cause).toContain("bash");
  });

  it("unknown driver when no composition", () => {
    const turns = [turn(0, 1000), turn(1, 1100)];
    const deltas = computeTurnDeltas(turns);
    expect(deltas[0].driver).toBe("unknown");
  });
});

describe("sparkline", () => {
  it("returns same number of elements as input", () => {
    const values = [0, 100, 200, 300, 400];
    expect(sparkline(values)).toHaveLength(5);
  });

  it("max value gets the full block", () => {
    const values = [0, 500, 1000];
    const lines = sparkline(values);
    expect(lines[2]).toBe("█");
  });

  it("zero value gets minimum block", () => {
    const values = [0, 1000];
    const lines = sparkline(values);
    expect(lines[0]).toBe("▏");
  });
});
