// report subcommand: delegates to scripts/report.ts, optionally saves output.
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { saveReport } from "./output.ts";
import type { ParsedArgs } from "./args.ts";
import { flagBool, flagInt } from "./args.ts";

export function runReport(parsed: ParsedArgs, scriptsDir: string): void {
  const days = flagInt(parsed.flags, "days", 7);
  const save = !flagBool(parsed.flags, "no-save", false);
  const format = parsed.flags.get("format") ?? "md";
  const withContent = flagBool(parsed.flags, "content", false);

  const scriptPath = path.join(scriptsDir, "report.ts");
  if (!fs.existsSync(scriptPath)) {
    console.error(`Cannot find report script at: ${scriptPath}`);
    console.error("The plugin installation may be broken. Try: npm install opencode-telemetry@latest");
    process.exit(64);
  }

  const spawnArgs = ["run", scriptPath, "--days", String(days)];
  if (withContent) spawnArgs.push("--content");

  const result = spawnSync("bun", spawnArgs, {
    encoding: "utf8",
    env: { ...process.env, OCTM_DAYS: String(days) },
  });

  if (result.error) {
    console.error(`Failed to run report script: ${result.error.message}`);
    console.error("Ensure Bun is installed and in PATH: https://bun.sh");
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(`Report script exited with code ${result.status}. Expected script: ${scriptPath}`);
    process.exit(result.status ?? 1);
  }

  const output = result.stdout;
  if (result.stderr) process.stderr.write(result.stderr);

  if (format === "json") {
    console.log(JSON.stringify({ report: output, generated_at: new Date().toISOString() }));
    return;
  }

  if (save) {
    const filepath = saveReport(output, "report");
    process.stdout.write(output);
    console.error(`\nReport saved to: ${filepath}`);
  } else {
    process.stdout.write(output);
  }
}
