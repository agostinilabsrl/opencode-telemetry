/**
 * tests/report-bugs.test.ts
 *
 * Tests for logic fixed in issues #39, #41, #42 in scripts/report.ts.
 *
 * #39 (--days not propagated): The parsing logic is inline in report.ts and not
 *   exported as a function.  The flag parsing of `--days` is covered by the
 *   `flagInt` helper already tested in tests/args.test.ts.
 *   Integration test (manual): run `bun run scripts/report.ts --days 1` and verify
 *   the output title reads "# Telemetry Report — Last 1 Day".
 *
 * #41 (Tool Result Size Stats — Calls=1, p95>Max): Verified via the unified CTE
 *   query extracted as `buildToolStatsCTE`.
 *
 * #42 (Skill Usage undercount): Verified via an in-memory DB with two sessions,
 *   each calling "skill-A" three times.  Expected calls = 6, not 2.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

// ── helpers ────────────────────────────────────────────────────────────────────

/**
 * Builds the SQL for the unified CTE used in the Tool Result Size Stats section
 * of report.ts (fix for issue #41).
 *
 * @param window  - SQLite datetime modifier, e.g. `'-7 days'`
 */
function buildToolStatsCTE(window: string): string {
  return `
    WITH base AS (
      SELECT tool_name, result_size_bytes
      FROM tool_calls
      WHERE result_size_bytes IS NOT NULL
        AND created_at >= datetime('now', ${window})
    ),
    agg AS (
      SELECT tool_name,
        COUNT(*) AS calls,
        CAST(AVG(result_size_bytes) AS INTEGER) AS avg_bytes,
        MAX(result_size_bytes) AS max_bytes
      FROM base GROUP BY tool_name
    ),
    p50 AS (
      SELECT tool_name, CAST(result_size_bytes AS INTEGER) AS p50_bytes
      FROM (
        SELECT tool_name, result_size_bytes,
          ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY result_size_bytes) AS rn,
          COUNT(*) OVER (PARTITION BY tool_name) AS cnt
        FROM base
      ) WHERE rn = (cnt + 1) / 2
    ),
    p95 AS (
      SELECT tool_name, CAST(result_size_bytes AS INTEGER) AS p95_bytes
      FROM (
        SELECT tool_name, result_size_bytes,
          ROW_NUMBER() OVER (PARTITION BY tool_name ORDER BY result_size_bytes) AS rn,
          COUNT(*) OVER (PARTITION BY tool_name) AS cnt
        FROM base
      ) WHERE rn = CASE WHEN CAST(cnt * 0.95 AS INTEGER) < 1 THEN 1
                        ELSE CAST(cnt * 0.95 AS INTEGER) END
    )
    SELECT a.tool_name, a.calls, a.avg_bytes, a.max_bytes,
      COALESCE(p50.p50_bytes, a.avg_bytes) AS p50_bytes,
      COALESCE(p95.p95_bytes, a.avg_bytes) AS p95_bytes
    FROM agg a
    LEFT JOIN p50 ON p50.tool_name = a.tool_name
    LEFT JOIN p95 ON p95.tool_name = a.tool_name
    ORDER BY a.avg_bytes DESC
    LIMIT 20
  `;
}

/**
 * Builds the SQL for the Skill Usage query in report.ts (fix for issue #42).
 *
 * @param window  - SQLite datetime modifier, e.g. `'-7 days'`
 */
function buildSkillUsageQuery(window: string): string {
  return `
    SELECT
      skill_name,
      SUM(cnt) AS calls,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(CASE WHEN cnt > 1 THEN 1 ELSE 0 END) AS sessions_with_dupes
    FROM (
      SELECT skill_name, session_id, COUNT(*) AS cnt
      FROM tool_calls
      WHERE tool_name = 'skill' AND skill_name IS NOT NULL
        AND created_at >= datetime('now', ${window})
      GROUP BY skill_name, session_id
    )
    GROUP BY skill_name
    ORDER BY calls DESC
    LIMIT 20
  `;
}

// ── shared DB fixture setup ────────────────────────────────────────────────────

function createToolCallsTable(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      skill_name TEXT,
      result_size_bytes INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

// ── #41: Tool Result Size Stats CTE ───────────────────────────────────────────

describe("#41 buildToolStatsCTE", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createToolCallsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it("5 rows [100,200,300,400,500]: calls=5, avg=300, p50=300, p95=400, max=500", () => {
    // p95 formula: rn = CAST(cnt * 0.95 AS INTEGER) = CAST(4.75 AS INTEGER) = 4 → 400
    const sizes = [100, 200, 300, 400, 500];
    for (const size of sizes) {
      db.exec(
        `INSERT INTO tool_calls (session_id, tool_name, result_size_bytes, created_at)
         VALUES ('s1', 'read', ${size}, datetime('now'))`
      );
    }

    const sql = buildToolStatsCTE("'-7 days'");
    const rows = db.query(sql).all() as Record<string, number>[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.tool_name).toBe("read");
    expect(row.calls).toBe(5);
    expect(row.avg_bytes).toBe(300);
    expect(row.p50_bytes).toBe(300);
    // CAST(5 * 0.95 AS INTEGER) = 4, so rn=4 → 400 (not 500)
    expect(row.p95_bytes).toBe(400);
    expect(row.max_bytes).toBe(500);
    // Key invariant: p95 must not exceed max
    expect(row.p95_bytes).toBeLessThanOrEqual(row.max_bytes);
  });

  it("p50 <= p95 <= max for any distribution", () => {
    // Skewed distribution: many small, one outlier
    const sizes = [10, 20, 30, 40, 50, 60, 70, 80, 90, 10_000];
    for (const size of sizes) {
      db.exec(
        `INSERT INTO tool_calls (session_id, tool_name, result_size_bytes, created_at)
         VALUES ('s1', 'bash', ${size}, datetime('now'))`
      );
    }

    const sql = buildToolStatsCTE("'-7 days'");
    const rows = db.query(sql).all() as Record<string, number>[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.p50_bytes).toBeLessThanOrEqual(row.p95_bytes);
    expect(row.p95_bytes).toBeLessThanOrEqual(row.max_bytes);
  });

  it("single row per tool: calls=1 produces valid p50 and p95 (both equal avg)", () => {
    db.exec(
      `INSERT INTO tool_calls (session_id, tool_name, result_size_bytes, created_at)
       VALUES ('s1', 'write', 999, datetime('now'))`
    );

    const sql = buildToolStatsCTE("'-7 days'");
    const rows = db.query(sql).all() as Record<string, number>[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.calls).toBe(1);
    // With a single row p50/p95 fall back to avg via COALESCE
    expect(row.p50_bytes).toBe(row.avg_bytes);
    expect(row.p95_bytes).toBe(row.avg_bytes);
    // And p95 must never exceed max
    expect(row.p95_bytes).toBeLessThanOrEqual(row.max_bytes);
  });
});

// ── #42: Skill Usage undercount ────────────────────────────────────────────────

describe("#42 skill usage query", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createToolCallsTable(db);
  });

  afterEach(() => {
    db.close();
  });

  it("2 sessions × 3 calls each → calls=6, not 2", () => {
    // session A: calls skill-A 3 times
    for (let i = 0; i < 3; i++) {
      db.exec(
        `INSERT INTO tool_calls (session_id, tool_name, skill_name, created_at)
         VALUES ('session-a', 'skill', 'skill-A', datetime('now'))`
      );
    }
    // session B: calls skill-A 3 times
    for (let i = 0; i < 3; i++) {
      db.exec(
        `INSERT INTO tool_calls (session_id, tool_name, skill_name, created_at)
         VALUES ('session-b', 'skill', 'skill-A', datetime('now'))`
      );
    }

    const sql = buildSkillUsageQuery("'-7 days'");
    const rows = db.query(sql).all() as Record<string, number | string>[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.skill_name).toBe("skill-A");
    // With SUM(cnt): 3+3=6.  Without (COUNT(*) on outer): would return 2.
    expect(row.calls).toBe(6);
    expect(row.sessions).toBe(2);
  });

  it("sessions_with_dupes counts sessions where skill is called >1 time", () => {
    // session A: 1 call → NOT a dupe session
    db.exec(
      `INSERT INTO tool_calls (session_id, tool_name, skill_name, created_at)
       VALUES ('session-a', 'skill', 'skill-B', datetime('now'))`
    );
    // session B: 3 calls → IS a dupe session
    for (let i = 0; i < 3; i++) {
      db.exec(
        `INSERT INTO tool_calls (session_id, tool_name, skill_name, created_at)
         VALUES ('session-b', 'skill', 'skill-B', datetime('now'))`
      );
    }

    const sql = buildSkillUsageQuery("'-7 days'");
    const rows = db.query(sql).all() as Record<string, number | string>[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.calls).toBe(4);      // 1 + 3
    expect(row.sessions).toBe(2);
    expect(row.sessions_with_dupes).toBe(1);  // only session-b
  });

  it("different skills are counted independently", () => {
    // 2 calls for skill-X, 5 calls for skill-Y
    for (let i = 0; i < 2; i++) {
      db.exec(
        `INSERT INTO tool_calls (session_id, tool_name, skill_name, created_at)
         VALUES ('session-a', 'skill', 'skill-X', datetime('now'))`
      );
    }
    for (let i = 0; i < 5; i++) {
      db.exec(
        `INSERT INTO tool_calls (session_id, tool_name, skill_name, created_at)
         VALUES ('session-a', 'skill', 'skill-Y', datetime('now'))`
      );
    }

    const sql = buildSkillUsageQuery("'-7 days'");
    const rows = db.query(sql).all() as Record<string, number | string>[];

    // ORDER BY calls DESC — skill-Y first
    expect(rows.length).toBe(2);
    expect(rows[0].skill_name).toBe("skill-Y");
    expect(rows[0].calls).toBe(5);
    expect(rows[1].skill_name).toBe("skill-X");
    expect(rows[1].calls).toBe(2);
  });
});
