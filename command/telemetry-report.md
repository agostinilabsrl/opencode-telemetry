---
description: Generate and save a telemetry report (default last 7 days; pass --days N for a custom window). Returns the saved file path.
---

You are running the telemetry-report command.

Find the `octm` CLI and run it with `--save`, which writes the report to disk and returns the path.
Pass `--days N` to change the time window (e.g. `--days 1` for today, `--days 30` for a month):

```bash
octm report --save 2>&1 \
  || bun run "$(bun pm ls -g 2>/dev/null | grep opencode-telemetry | awk '{print $1}')/bin/cli.ts" report --save 2>&1 \
  || bun run ~/.config/opencode/plugin/opencode-telemetry/bin/cli.ts report --save 2>&1 \
  || echo "ERROR: could not locate octm. Make sure bun is in PATH and opencode-telemetry is installed."
```

The command will output the report followed by a line like:
```
Report saved to: ~/.local/share/opencode-telemetry/reports/report-2026-05-06T10-30-00.md
```

**Return only the saved file path to the user** — do not re-read or re-emit the report contents. The user can open the file directly. If the command fails, show the error output.
