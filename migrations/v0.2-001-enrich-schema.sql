-- v0.2 schema enrichment (additive only — no column drops, no type changes)
--
-- turns: add parent_tool_call_id (the tool call in the parent session that spawned this child)
-- tool_calls: add tool_call_id (SDK call ID for correlation) and spawned_session_id
-- sessions: add server_url (stored so the CLI can reconstruct the SDK client)

ALTER TABLE turns ADD COLUMN parent_tool_call_id TEXT;
ALTER TABLE tool_calls ADD COLUMN tool_call_id TEXT;
ALTER TABLE tool_calls ADD COLUMN spawned_session_id TEXT;
ALTER TABLE sessions ADD COLUMN server_url TEXT;

CREATE INDEX IF NOT EXISTS idx_turns_parent_tool ON turns(parent_tool_call_id) WHERE parent_tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_id ON tool_calls(tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tool_calls_spawned ON tool_calls(spawned_session_id) WHERE spawned_session_id IS NOT NULL;

INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '2');
