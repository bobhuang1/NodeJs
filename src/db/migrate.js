"use strict";
/* Migration runner (mirrors internal/store/db.go EmbeddedMigrator):
 * - embedded *.sql under src/db/migrations applied in lexical (filename) order.
 * - each migration runs in a single transaction and records its name in
 *   schema_migrations(name TEXT PRIMARY KEY, applied_at timestamptz not null
 *   default now()); already-applied names are skipped.
 * - whole migration file is wrapped in its own BEGIN/COMMIT (001_init.sql does so).
 */
const fs = require("fs");
const path = require("path");

async function RunMigrations(pool, dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  await pool.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  for (const f of files) {
    const existing = await pool.queryRow(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [f]
    );
    if (existing) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    const tx = await pool.begin();
    try {
      await tx.exec(sql);
      await tx.exec("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await tx.commit();
    } catch (err) {
      await tx.rollback();
      throw err;
    }
  }
}

module.exports = { RunMigrations };
