-- Input/output token ratio per agent and model (last 7 days).
-- High ratio = large context relative to output = potential context bloat.
SELECT
  agent,
  model,
  SUM(input_tokens + COALESCE(cached_read_tokens, 0)) AS total_in,
  SUM(output_tokens)                                   AS total_out,
  ROUND(
    1.0 * SUM(input_tokens + COALESCE(cached_read_tokens, 0))
        / NULLIF(SUM(output_tokens), 0),
    1
  ) AS in_out_ratio,
  COUNT(*) AS turns
FROM turns
WHERE created_at >= datetime('now', '-7 days')
GROUP BY agent, model
ORDER BY in_out_ratio DESC;
