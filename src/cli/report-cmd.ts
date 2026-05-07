// report subcommand: delegates to scripts/report.ts, optionally saves output.
import { spawnSync } from "child_process";
import path from "path";
import { saveReport } from "./output.ts";
import type { ParsedArgs } from "./args.ts";
import { flagBool, flagInt } from "./args.ts";

export function runReport(parsed: ParsedArgs): void {
  const days = flagInt(parsed.flags, "days", 7);
  const save = !flagBool(parsed.flags, "no-save", false);
  const format = parsed.flags.get("format") ?? "md";

  // Locate the report script relative to this file's position in the package
  const scriptPath = path.resolve(import.meta.dir, "../scripts/report.ts");

  const result = spawnSync("bun", ["run", scriptPath, "--days", String(days)], {
    encoding: "utf8",
    env: { ...process.env, OCTM_DAYS: String(days) },
  });

  if (result.error) {
    console.error("Failed to run report script:", result.error.message);
    process.exit(1);
  }

  const output = result.stdout;
  if (result.stderr) process.stderr.write(result.stderr);

  if (format === "json") {
    // Minimal JSON wrapper around the markdown
    console.log(JSON.stringify({ report: output, generated_at: new Date().toISOString() }));
    return;
  }

  if (save) {
    const filepath = saveReport(output, "report");
    // Print the output then the save path
    process.stdout.write(output);
    console.error(`\nReport saved to: ${filepath}`);
  } else {
    process.stdout.write(output);
  }
}
