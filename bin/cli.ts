#!/usr/bin/env bun
// octm — opencode-telemetry CLI
// Usage: octm <command> [subcommand] [args] [--flags]
import { parseArgs } from "../src/cli/args.ts";
import { runReport } from "../src/cli/report-cmd.ts";
import { runInspect } from "../src/cli/inspect-cmd.ts";
import { runConfig } from "../src/cli/config-cmd.ts";
import { runCache } from "../src/cli/cache-cmd.ts";
import { runSql } from "../src/cli/sql-cmd.ts";

const parsed = parseArgs(process.argv.slice(2));

const HELP = `
octm — opencode-telemetry CLI

Commands:
  octm report [--days N] [--save] [--no-save] [--format md|json]
  octm inspect <session_id> [--content] [--save] [--no-save]
  octm config show|get <key>|set <key> <value>|reset
  octm cache stats|clear [--older-than 30d]|prefetch <session_id>
  octm sql "<query>" | --file <path>
  octm help
`.trim();

switch (parsed.command) {
  case "report":
    runReport(parsed);
    break;
  case "inspect":
    await runInspect(parsed);
    break;
  case "config":
    runConfig(parsed);
    break;
  case "cache":
    await runCache(parsed);
    break;
  case "sql":
    runSql(parsed);
    break;
  case "help":
  case "--help":
  case "-h":
  case "":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${parsed.command}\n\n${HELP}`);
    process.exit(1);
}
