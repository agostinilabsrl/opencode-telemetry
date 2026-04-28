-- Top 20 sessions by estimated cost in the last 7 days.
SELECT
  s.session_id,
  s.primary_agent,
  s.project_path,
  s.total_input_tokens + s.total_output_tokens AS total_tokens,
  s.est_cost_usd,
  s.total_turns,
  s.started_at
FROM sessions s
WHERE s.started_at >= datetime('now', '-7 days')
  AND s.est_cost_usd IS NOT NULL
ORDER BY s.est_cost_usd DESC
LIMIT 20;
