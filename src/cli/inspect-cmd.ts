// inspect subcommand: delegates to scripts/inspect.ts, optionally saves output.
import { spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { saveReport } from "./output.ts";
import type { ParsedArgs } from "./args.ts";
import { flagBool } from "./args.ts";

export async function runInspect(parsed: ParsedArgs): Promise<void> {
  const sessionId = parsed.subcommand ?? parsed.positionals[0];
  if (!sessionId) {
    console.error("Usage: octm inspect <session_id> [--content] [--save] [--no-save]");
    process.exit(1);
  }

  const withContent = flagBool(parsed.flags, "content", false);
  const save = !flagBool(parsed.flags, "no-save", false);

  // src/cli/ → ../../scripts/
  const scriptPath = path.resolve(import.meta.dir, "../../scripts/inspect.ts");
  if (!fs.existsSync(scriptPath)) {
    console.error(`Cannot find inspect script at: ${scriptPath}`);
    console.error("The plugin installation may be broken. Try: npm install opencode-telemetry@latest");
    process.exit(64);
  }

  const args = [sessionId];
  if (withContent) args.push("--content");

  const result = spawnSync("bun", ["run", scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env },
  });

  if (result.error) {
    console.error(`Failed to run inspect script: ${result.error.message}`);
    console.error("Ensure Bun is installed and in PATH: https://bun.sh");
    process.exit(1);
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(`Inspect script exited with code ${result.status}. Expected script: ${scriptPath}`);
    process.exit(result.status ?? 1);
  }

  const output = result.stdout;
  if (result.stderr) process.stderr.write(result.stderr);

  if (save) {
    const short = sessionId.slice(0, 12);
    const filepath = saveReport(output, `inspect-${short}`);
    process.stdout.write(output);
    console.error(`\nInspect report saved to: ${filepath}`);
  } else {
    process.stdout.write(output);
  }
}
