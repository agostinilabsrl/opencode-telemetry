import fs from "fs";
import path from "path";

export function registerCommands(pluginSrcDir: string, projectDir: string): void {
  try {
    const scriptsDir = path.resolve(pluginSrcDir, "..", "scripts");
    const commandsDir = path.join(projectDir, ".opencode", "commands");
    fs.mkdirSync(commandsDir, { recursive: true });

    const reportMd = `---
description: Show a markdown report of recent telemetry (last 7 days by default).
---

Run this command and display the output verbatim. Do not interpret, summarize, or modify it.

\`\`\`bash
bun run ${JSON.stringify(path.join(scriptsDir, "report.ts"))} || node ${JSON.stringify(path.join(scriptsDir, "report.js"))}
\`\`\`
`;

    const inspectMd = `---
description: Deep-dive into a specific session by ID or "latest". Shows per-turn metrics, tool calls, and cost.
argument-hint: <session_id|latest>
---

Run this command with the argument and display the output verbatim. Do not interpret, summarize, or modify it.

\`\`\`bash
bun run ${JSON.stringify(path.join(scriptsDir, "inspect.ts"))} "$ARGUMENTS" || node ${JSON.stringify(path.join(scriptsDir, "inspect.js"))} "$ARGUMENTS"
\`\`\`
`;

    fs.writeFileSync(path.join(commandsDir, "telemetry-report.md"), reportMd, "utf8");
    fs.writeFileSync(path.join(commandsDir, "telemetry-inspect.md"), inspectMd, "utf8");
  } catch (err) {
    console.warn("[opencode-telemetry] registerCommands failed:", err);
  }
}
