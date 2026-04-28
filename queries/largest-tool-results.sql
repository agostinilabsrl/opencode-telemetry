-- Largest individual tool result payloads (top 50 all time).
SELECT
  session_id,
  tool_name,
  skill_name,
  result_size_bytes,
  duration_ms,
  created_at
FROM tool_calls
WHERE result_size_bytes IS NOT NULL
ORDER BY result_size_bytes DESC
LIMIT 50;
