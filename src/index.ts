import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import path from "path";
import { initDatabase } from "./db.ts";
import { createHandlers } from "./handlers.ts";
import { registerCommands } from "./commands.ts";

const TelemetryPlugin: Plugin = async (ctx) => {
  // Pass the PACKAGE ROOT (one level above src/) instead of the src/ directory
  // itself, so registerCommands() can locate the portable templates shipped
  // under command/ (command/telemetry-report.md, command/telemetry-inspect.md).
  // Previously the absolute src/ path was used to derive scripts/ and bake
  // host-specific absolute paths into command bodies, polluting
  // .opencode/commands/ on every plugin load.
  registerCommands(path.resolve(import.meta.dir, ".."), ctx.directory);
  const db = initDatabase();
  const { onEvent, onToolBefore, onToolAfter } = createHandlers(db, ctx);

  return {
    event: onEvent,
    "tool.execute.before": onToolBefore,
    "tool.execute.after": onToolAfter,
  };
};

// opencode loads plugins as PluginModule ({ server: Plugin }) or bare Plugin
export const server: Plugin = TelemetryPlugin;
export default TelemetryPlugin;
