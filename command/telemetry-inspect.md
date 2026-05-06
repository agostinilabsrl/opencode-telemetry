---
description: Inspect a session by ID. Shows token trajectory, agent chain, and per-turn breakdown. Returns the saved file path.
argument-hint: <session_id> [--content]
---

You are running telemetry-inspect for session: $ARGUMENTS

Run the inspect command with `--save`, which writes the report to disk and returns the path:

```bash
octm inspect $ARGUMENTS --save 2>&1 \
  || bun run "$(bun pm ls -g 2>/dev/null | grep opencode-telemetry | awk '{print $1}')/bin/cli.ts" inspect $ARGUMENTS --save 2>&1 \
  || bun run ~/.config/opencode/plugin/opencode-telemetry/bin/cli.ts inspect $ARGUMENTS --save 2>&1 \
  || echo "ERROR: could not locate octm. Make sure bun is in PATH and opencode-telemetry is installed."
```

The command will output the report followed by a line like:
```
Inspect report saved to: ~/.local/share/opencode-telemetry/reports/inspect-<session_short>-2026-05-06T10-30-00.md
```

**Return only the saved file path to the user** — do not re-read or re-emit the report contents. The user can open the file directly.

To include full prompt content in the report (requires opencode server running), add `--content` to the arguments.
