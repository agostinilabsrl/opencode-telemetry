-- Daily token totals for the last 30 days.
SELECT
  DATE(created_at)                                        AS day,
  SUM(COALESCE(input_tokens, 0) + COALESCE(cached_read_tokens, 0)) AS input_total,
  SUM(COALESCE(output_tokens, 0))                         AS output_total,
  COUNT(DISTINCT session_id)                              AS sessions,
  COUNT(*)                                                AS turns
FROM turns
WHERE created_at >= datetime('now', '-30 days')
GROUP BY day
ORDER BY day DESC;
