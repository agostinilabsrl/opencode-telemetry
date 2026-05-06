import { loadConfig, saveConfig, resetConfig, getConfigKey, setConfigKey, DEFAULT_CONFIG } from "../config.ts";
import type { ParsedArgs } from "./args.ts";

export function runConfig(parsed: ParsedArgs): void {
  const sub = parsed.subcommand; // get | set | show | reset
  const args = parsed.positionals;

  if (!sub || sub === "show") {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (sub === "get") {
    const key = args[0];
    if (!key) { console.error("Usage: octm config get <key>"); process.exit(1); }
    const config = loadConfig();
    const val = getConfigKey(config, key);
    if (val === undefined) { console.error(`Unknown key: ${key}`); process.exit(1); }
    console.log(JSON.stringify(val));
    return;
  }

  if (sub === "set") {
    const key = args[0];
    const value = args[1];
    if (!key || value === undefined) { console.error("Usage: octm config set <key> <value>"); process.exit(1); }
    const config = loadConfig();
    try {
      const updated = setConfigKey(config, key, value);
      saveConfig(updated);
      console.log(`Set ${key} = ${JSON.stringify(getConfigKey(updated, key))}`);
    } catch (err) {
      console.error(String(err));
      process.exit(1);
    }
    return;
  }

  if (sub === "reset") {
    resetConfig();
    console.log("Config reset to defaults.");
    return;
  }

  console.error(`Unknown config subcommand: ${sub}. Use: show | get | set | reset`);
  process.exit(1);
}
