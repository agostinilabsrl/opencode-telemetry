---
description: Show a markdown report of recent telemetry (last 7 days by default).
---

You are running the telemetry-report command.

Find the opencode-telemetry plugin installation directory and run the report script:

```bash
bun run "$(bun pm ls -g 2>/dev/null | grep opencode-telemetry | awk '{print $1}')/scripts/report.ts" 2>/dev/null \
  || bun run ~/.config/opencode/plugin/opencode-telemetry/scripts/report.ts 2>/dev/null \
  || node ~/.config/opencode/plugin/opencode-telemetry/scripts/report.js
```

If the above fails, locate the plugin with `find ~/.config/opencode -name "report.ts" -o -name "report.js" 2>/dev/null | head -1` and run it with bun or node.

Display the output verbatim. Do not interpret, summarize, or modify.
