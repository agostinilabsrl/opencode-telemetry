-- Cache hit rate by provider and model.
-- Low hit_pct = cache not warming = context resets frequently.
SELECT
  provider_id,
  model,
  SUM(COALESCE(cached_read_tokens, 0))  AS cached,
  SUM(COALESCE(input_tokens, 0))        AS fresh,
  ROUND(
    100.0 * SUM(COALESCE(cached_read_tokens, 0))
          / NULLIF(SUM(COALESCE(cached_read_tokens, 0) + COALESCE(input_tokens, 0)), 0),
    1
  ) AS cache_hit_pct
FROM turns
WHERE cached_read_tokens IS NOT NULL
GROUP BY provider_id, model
ORDER BY cache_hit_pct ASC;
