"use strict";
/* Email outbox worker CLI — standalone equivalent of internal/email
 * Service.Run: N parallel workers claim pending rows (FOR UPDATE SKIP LOCKED)
 * and deliver through the relay with retry/backoff. The default relay logs and
 * succeeds (a dev seam; no SMTP dependency). Reacts to SIGINT/SIGTERM. */
const path = require("node:path");
const { LeanPool } = require("../db/pool.js");
const { RunMigrations } = require("../db/migrate.js");
const config = require("../config.js");
const email = require("./email.service.js");

function consoleRelay() {
  return {
    async send(params) {
      console.log("email relay", JSON.stringify(params));
    },
  };
}

async function main() {
  const workers = Number(process.env.EMAIL_WORKER_WORKERS || 2);
  const pool = new LeanPool(config.databaseURL);
  try {
    await pool.ping();
  } catch (err) {
    console.error("database setup failed", err);
    process.exit(1);
  }
  await RunMigrations(pool, path.join(__dirname, "..", "db", "migrations"));

  const run = email.run(
    { pool, relay: consoleRelay() },
    { workers, maxAttempts: config.emailMaxAttempts, baseDelayMs: config.emailBaseDelayMs }
  );
  console.log("email worker running", "workers", workers);

  const shutdown = () => {
    run.stop();
    run.done().then(async () => {
      try { await pool.close(); } catch (_) { /* best-effort */ }
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});