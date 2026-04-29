// Cross-runtime SQLite adapter.
// In Bun: delegates to bun:sqlite (native, sync).
// In Node 22.5+: wraps node:sqlite's DatabaseSync to expose the same
// .query(sql).all(params) interface the scripts rely on.
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

interface QueryResult {
  all(params?: Record<string, unknown>): unknown[];
}

interface DbHandle {
  query(sql: string): QueryResult;
  close(): void;
}

export function openDatabase(dbPath: string): DbHandle {
  if (typeof Bun !== "undefined") {
    // bun:sqlite already exposes .query(sql).all(params) and .close()
    const { Database } = _require("bun:sqlite") as typeof import("bun:sqlite");
    return new Database(dbPath, { readonly: true }) as unknown as DbHandle;
  }

  // Node 22.5+ built-in sqlite
  const { DatabaseSync } = _require("node:sqlite") as {
    DatabaseSync: new (path: string) => {
      prepare(sql: string): { all(params?: Record<string, unknown>): unknown[] };
      close(): void;
    };
  };
  const db = new DatabaseSync(dbPath);
  return {
    query: (sql: string): QueryResult => ({
      all: (params?: Record<string, unknown>) => db.prepare(sql).all(params),
    }),
    close: () => db.close(),
  };
}
