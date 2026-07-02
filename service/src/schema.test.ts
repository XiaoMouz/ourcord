import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// Node ≥22.5 built-in; D1 is SQLite-compatible so this is a faithful executor.
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "./schema";

// Guard against the migration-gap class of bug: schema.ts (dev init-db) and
// migrations/ (canonical, `wrangler d1 migrations apply`) must produce the
// same database. A column added to a CREATE TABLE in schema.ts but never
// shipped as a migration bricks every already-initialized database, because
// CREATE TABLE IF NOT EXISTS silently skips existing tables.
//
// Comparison is on the RESULTING schema (sqlite_master), not the SQL text, so
// future `ALTER TABLE … ADD COLUMN` migrations compare correctly against the
// updated CREATE TABLE in schema.ts.

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

function schemaOf(applySQL: (db: DatabaseSync) => void): Map<string, string> {
  const db = new DatabaseSync(":memory:");
  try {
    applySQL(db);
    const rows = db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf%' ESCAPE '\\'
         ORDER BY name`,
      )
      .all() as unknown as Array<{ type: string; name: string; sql: string }>;
    return new Map(rows.map((r) => [`${r.type}:${r.name}`, r.sql.replace(/\s+/g, " ").trim()]));
  } finally {
    db.close();
  }
}

describe("schema.ts ↔ migrations/ equivalence", () => {
  const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  it("has an ordered migrations directory", () => {
    expect(migrationFiles.length).toBeGreaterThan(0);
    expect(migrationFiles[0]).toMatch(/^0001_/);
  });

  it("applying all migrations yields the same schema as SCHEMA_SQL", () => {
    const migrated = schemaOf((db) => {
      for (const f of migrationFiles) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    });
    const declared = schemaOf((db) => db.exec(SCHEMA_SQL));

    // Compare object-by-object for readable failures.
    expect([...migrated.keys()].sort()).toEqual([...declared.keys()].sort());
    for (const [key, sql] of declared) {
      expect(migrated.get(key), key).toBe(sql);
    }
  });
});
