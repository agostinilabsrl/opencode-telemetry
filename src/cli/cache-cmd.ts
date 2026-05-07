import { effectiveConfig, loadConfig } from "../config.ts";
import { ContentCache } from "../content-cache.ts";
import { fetchSessionMessages } from "../sdk-bridge.ts";
import { getDbPath } from "../paths.ts";
import { openDatabase } from "../../scripts/db-compat.ts";
import type { ParsedArgs } from "./args.ts";
import fs from "fs";

function makeCache(): ContentCache {
  const cfg = effectiveConfig(loadConfig());
  return new ContentCache(cfg.content_cache.path, cfg.content_cache.enabled);
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

export async function runCache(parsed: ParsedArgs): Promise<void> {
  const sub = parsed.subcommand;

  if (!sub || sub === "stats") {
    const cache = makeCache();
    const stats = cache.stats();
    console.log(`Cache path: ${effectiveConfig(loadConfig()).content_cache.path}`);
    console.log(`Sessions cached: ${stats.sessions}`);
    console.log(`Files: ${stats.files}`);
    console.log(`Total size: ${fmtBytes(stats.totalBytes)}`);
    return;
  }

  if (sub === "clear") {
    const olderThan = parsed.flags.get("older-than");
    const cache = makeCache();
    let removed: number;
    if (typeof olderThan === "string") {
      const match = olderThan.match(/^(\d+)d$/);
      if (!match) { console.error("--older-than must be in format <N>d (e.g. 30d)"); process.exit(1); }
      const ms = parseInt(match[1], 10) * 24 * 60 * 60 * 1000;
      removed = cache.clearOlderThan(ms);
    } else {
      removed = cache.clearAll();
    }
    console.log(`Removed ${removed} cached file(s).`);
    return;
  }

  if (sub === "prefetch") {
    const sessionId = parsed.positionals[0];
    if (!sessionId) { console.error("Usage: octm cache prefetch <session_id>"); process.exit(1); }

    const dbPath = getDbPath();
    if (!fs.existsSync(dbPath)) { console.error("No telemetry database found."); process.exit(1); }
    const db = openDatabase(dbPath);
    const rows = db.query(
      "SELECT server_url FROM sessions WHERE server_url IS NOT NULL ORDER BY started_at DESC LIMIT 1"
    ).all({}) as { server_url: string }[];
    db.close();

    const serverUrl = rows[0]?.server_url ?? null;

    console.log(`Prefetching messages for session ${sessionId}...`);
    const msgs = await fetchSessionMessages(sessionId, serverUrl);
    console.log(`Cached ${msgs.length} message(s) for session ${sessionId}.`);
    return;
  }

  console.error(`Unknown cache subcommand: ${sub}. Use: stats | clear | prefetch`);
  process.exit(1);
}
