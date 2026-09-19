"use strict";
/* Cache seam — retry wrapper over ioredis with exponential backoff + jitter,
 * op timeout, and transient-error classification. Mirrors GoLang internal/cache
 * retry.go exactly (makeCacheRetry / BackoffDelay + jitter). */

const { BackoffDelay, BackoffDelayPinned } = require("./backoff.js");

function isTransient(err) {
  return !!(err && err.transient === true);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () =>
        reject(Object.assign(new Error(`cache op timed out after ${ms}ms`), { transient: true })),
      ms
    );
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

function makeRetry({ maxAttempts = 3, baseDelay = 40, opTimeout = 500, backoff = BackoffDelay }) {
  return async function retry(op, opName = "op") {
    let lastErr = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) await sleep(backoff(attempt - 1, baseDelay));
      try {
        return await withTimeout(op, opTimeout);
      } catch (err) {
        lastErr = err;
        if (!isTransient(err)) throw err;
      }
    }
    throw new Error(`cache ${opName}: ${lastErr ? lastErr.message : "unknown"}`);
  };
}

module.exports = { isTransient, sleep, withTimeout, makeRetry, BackoffDelay, BackoffDelayPinned };
