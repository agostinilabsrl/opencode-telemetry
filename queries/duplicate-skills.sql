-- Skills loaded more than once in the same session (potential duplicate loading).
SELECT
  session_id,
  skill_name,
  COUNT(*)              AS load_count,
  SUM(result_size_bytes) AS cumulative_bytes
FROM tool_calls
WHERE tool_name = 'skill'
  AND skill_name IS NOT NULL
GROUP BY session_id, skill_name
HAVING load_count > 1
ORDER BY cumulative_bytes DESC
LIMIT 50;
