// Utilities for saving CLI output to the reports directory.
import fs from "fs";
import path from "path";
import os from "os";

function reportsDir(): string {
  const base = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode-telemetry", "reports");
}

export function saveReport(content: string, prefix: string): string {
  const dir = reportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `${prefix}-${ts}.md`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, content, "utf8");
  return filepath;
}
