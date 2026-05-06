-- Recursive cost rollup for a full session tree (conductor + all subagent children).
-- Replace '<parent_session_id>' with the conductor session ID you want to inspect.
--
-- Shows depth (0 = root conductor, 1 = direct children, 2 = grandchildren),
-- agent name, token breakdown, and per-session estimated cost.
-- Sum est_cost_usd across all rows for the true billed total.

WITH RECURSIVE tree(session_id, parent_session_id, depth) AS (
  SELECT session_id, parent_session_id, 0
  FROM sessions
  WHERE session_id = '<parent_session_id>'
  UNION ALL
  SELECT s.session_id, s.parent_session_id, t.depth + 1
  FROM sessions s
  JOIN tree t ON s.parent_session_id = t.session_id
)
SELECT
  t.depth,
  s.session_id,
  COALESCE(s.primary_agent, '—') AS agent,
  s.total_turns,
  s.total_input_tokens  AS input_tok,
  s.total_output_tokens AS output_tok,
  s.total_cached_read   AS cache_read_tok,
  s.total_reasoning     AS reasoning_tok,
  ROUND(s.est_cost_usd, 6) AS est_cost_usd,
  s.started_at,
  s.ended_at
FROM tree t
JOIN sessions s ON t.session_id = s.session_id
ORDER BY t.depth, s.started_at;
