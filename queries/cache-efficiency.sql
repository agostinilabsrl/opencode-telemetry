-- Cache efficiency breakdown by provider and model for the last 7 days.
-- Shows cache read/write token volumes, hit ratio, and estimated savings
-- vs paying full input price for all tokens.
--
-- hit_pct formula:
--   cache_read / (cache_read + fresh_input) × 100
--
-- Replace the datetime filter to change the time window.

SELECT
  COALESCE(provider_id, '—') AS provider,
  COALESCE(model, '—') AS model,
  COUNT(*)                                                AS turns,
  SUM(COALESCE(cached_read_tokens, 0))                    AS cache_read_tok,
  SUM(COALESCE(cached_write_tokens, 0))                   AS cache_write_tok,
  SUM(COALESCE(input_tokens, 0))                          AS fresh_input_tok,
  ROUND(
    100.0 * SUM(COALESCE(cached_read_tokens, 0))
    / NULLIF(SUM(COALESCE(cached_read_tokens, 0) + COALESCE(input_tokens, 0)), 0),
    1
  )                                                       AS hit_pct
FROM turns
WHERE created_at >= datetime('now', '-7 days')
GROUP BY provider_id, model
ORDER BY hit_pct DESC NULLS LAST;
