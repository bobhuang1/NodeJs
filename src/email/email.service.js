"use strict";
/* Email outbox worker — NodeJs port of GoLang internal/email/email.service.go
 * (processOne verbatim: claim → up to maxAttempts, pre-retry sleep uses
 * BackoffDelay(attempt-1, base) then relayedSQL on success / bumpSQL with
 * BackoffDelay(attempt, base) + failure reason on transient / failSQL+alertSQL
 * on permanent or exhaustion). SQL text consts live in ./sql.js (verbatim). */
const { BackoffDelay, BackoffDelayPinned } = require("../cache/backoff.js");
const sql = require("./sql.js");

function isTransient(err) {
  return err && err.transient === true;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoffDelay(attempt, base) {
  return BackoffDelayPinned(attempt, base); // pinned = jitter 1.0 (tests)
}

/* processOne(deps): claim one pending row; deliver with retry+backoff;
 * returns { delivered, id, failed? }. Never throws (Go: silences; fail paths
 * go to processOne failForAdmin). */
async function processOne(deps, opts, logger = console) {
  const { maxAttempts = 5, baseDelayMs = 100 } = opts || {};
  const row = await deps.pool.queryRow(sql.claimSQL);
  if (!row) return { delivered: false, empty: true };
  const id = row.id;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(backoffDelay(attempt - 1, baseDelayMs));
    let deliverErr = null;
    try {
      await deps.relay.send({
        toAddress: row.to_address,
        subject: row.subject,
        body: row.body,
        idempotencyKey: row.idempotency_key,
      });
    } catch (e) {
      deliverErr = e;
    }

    if (!deliverErr) {
      await deps.pool.exec(sql.deliveredSQL, [id]);
      return { delivered: true, id };
    }

    lastErr = deliverErr;
    if (isTransient(deliverErr)) {
      await deps.pool.exec(sql.bumpSQL, [
        id,
        backoffDelay(attempt, baseDelayMs),
        deliverErr.message || String(deliverErr),
      ]);
      continue;
    }

    // permanent failure: fail immediately + alert admin
    await deps.pool.exec(sql.failSQL, [id, deliverErr.message || String(deliverErr)]);
    await deps.pool.exec(sql.alertSQL, [
      "email delivery failed: " + id,
      deliverErr.message || String(deliverErr),
    ]);
    return { delivered: false, id, failed: true };
  }

  // exhausted transient attempts, never delivered
  await deps.pool.exec(sql.failSQL, [id, lastErr ? lastErr.message || String(lastErr) : "max attempts exceeded"]);
  await deps.pool.exec(sql.alertSQL, ["email delivery failed: " + id, lastErr ? lastErr.message || String(lastErr) : "max attempts exceeded"]);
  return { delivered: false, id, failed: true };
}

/* run(workers): n concurrent worker loops, each processing one row then
 * sleeping 200ms when the queue is empty. */
async function run(deps, { workers = 1, maxAttempts = 5, baseDelayMs = 100, logger = console } = {}) {
  const stop = new AbortController();
  const jobs = [];
  for (let w = 0; w < workers; w++) {
    jobs.push(
      (async () => {
        while (!stop.signal.aborted) {
          try {
            await processOne(deps, { maxAttempts, baseDelayMs }, logger);
          } catch (e) {
            if (!stop.signal.aborted) logger.error("email worker error", e);
          }
          await sleep(200);
        }
      })()
    );
  }
  return {
    stop: () => stop.abort(),
    done: () => Promise.all(jobs),
  };
}

module.exports = { processOne, run, isTransient, sleep, backoffDelay };
