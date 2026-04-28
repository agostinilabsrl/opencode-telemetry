---
description: Deep-dive into a specific session by ID. Shows per-turn metrics, tool calls, and skill usage.
argument-hint: <session_id>
---

You are running telemetry-inspect for session ID: $ARGUMENTS

Find the opencode-telemetry plugin and run the inspect script with the session ID:

```bash
bun run "$(bun pm ls -g 2>/dev/null | grep opencode-telemetry | awk '{print $1}')/scripts/inspect.ts" "$ARGUMENTS" 2>/dev/null \
  || bun run ~/.config/opencode/plugin/opencode-telemetry/scripts/inspect.ts "$ARGUMENTS" 2>/dev/null \
  || node ~/.config/opencode/plugin/opencode-telemetry/scripts/inspect.js "$ARGUMENTS"
```

If the above fails, locate the plugin with `find ~/.config/opencode -name "inspect.ts" -o -name "inspect.js" 2>/dev/null | head -1` and run it with the session ID as the first argument.

Display the metrics output verbatim.

If the user wants to see the actual message contents for this session, suggest they use opencode's native session navigation (via the history feature or share URL if available).
