import pricingData from "./pricing.json" with { type: "json" };

type PricingEntry = {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
};

const pricing = pricingData as Record<string, PricingEntry | string>;

function getEntry(providerID: string, modelID: string): PricingEntry | null {
  const key = `${providerID}/${modelID}`;
  const entry = pricing[key];
  if (!entry || typeof entry === "string") return null;
  return entry as PricingEntry;
}

export function estimateCost(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }
): number | null {
  if (!providerID || !modelID) return null;
  const entry = getEntry(providerID, modelID);
  if (!entry) return null;

  return (
    (tokens.input * entry.input_per_mtok +
      tokens.output * entry.output_per_mtok +
      tokens.cacheRead * entry.cache_read_per_mtok +
      tokens.cacheWrite * entry.cache_write_per_mtok) /
    1_000_000
  );
}
