// Content cache: disk-backed store for fetched session message content.
// Path: <config.content_cache.path>/<session_id>/<message_id>.json.gz
// TTL: none (user manages via `octm cache clear`).
// Disabled when config.content_cache.enabled == false or in server mode.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export class ContentCache {
  constructor(private readonly basePath: string, private readonly enabled: boolean) {}

  private entryPath(sessionId: string, messageId: string): string {
    return path.join(this.basePath, sessionId, `${messageId}.json.gz`);
  }

  async get<T>(sessionId: string, messageId: string): Promise<T | null> {
    if (!this.enabled) return null;
    const p = this.entryPath(sessionId, messageId);
    try {
      const compressed = fs.readFileSync(p);
      const buf = await gunzip(compressed);
      return JSON.parse(buf.toString("utf8")) as T;
    } catch {
      return null;
    }
  }

  async set<T>(sessionId: string, messageId: string, data: T): Promise<void> {
    if (!this.enabled) return;
    const p = this.entryPath(sessionId, messageId);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const compressed = await gzip(JSON.stringify(data));
      fs.writeFileSync(p, compressed);
    } catch {
      // Cache write failures are non-fatal
    }
  }

  stats(): { sessions: number; files: number; totalBytes: number } {
    try {
      if (!fs.existsSync(this.basePath)) return { sessions: 0, files: 0, totalBytes: 0 };
      let files = 0;
      let totalBytes = 0;
      const sessionDirs = fs.readdirSync(this.basePath, { withFileTypes: true })
        .filter(d => d.isDirectory());
      for (const sd of sessionDirs) {
        const entries = fs.readdirSync(path.join(this.basePath, sd.name));
        files += entries.length;
        for (const e of entries) {
          try {
            totalBytes += fs.statSync(path.join(this.basePath, sd.name, e)).size;
          } catch { /* ignore */ }
        }
      }
      return { sessions: sessionDirs.length, files, totalBytes };
    } catch {
      return { sessions: 0, files: 0, totalBytes: 0 };
    }
  }

  clearOlderThan(maxAgeMs: number): number {
    let removed = 0;
    const cutoff = Date.now() - maxAgeMs;
    try {
      if (!fs.existsSync(this.basePath)) return 0;
      for (const sd of fs.readdirSync(this.basePath, { withFileTypes: true })) {
        if (!sd.isDirectory()) continue;
        const dir = path.join(this.basePath, sd.name);
        for (const f of fs.readdirSync(dir)) {
          const fp = path.join(dir, f);
          try {
            const mtime = fs.statSync(fp).mtimeMs;
            if (mtime < cutoff) { fs.unlinkSync(fp); removed++; }
          } catch { /* ignore */ }
        }
        try { fs.rmdirSync(dir); } catch { /* not empty */ }
      }
    } catch { /* ignore */ }
    return removed;
  }

  clearAll(): number {
    return this.clearOlderThan(0);
  }
}
