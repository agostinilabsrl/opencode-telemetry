import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import { initDatabase } from "./db.ts";
import { createHandlers } from "./handlers.ts";

const TelemetryPlugin: Plugin = async (ctx) => {
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
