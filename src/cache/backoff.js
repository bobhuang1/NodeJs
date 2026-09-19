"use strict";
/* BackoffDelay seam — shared by cache retry wrapper, payment retry loop and the
 * email outbox worker. Verbatim GoLang formula (internal/cache/backoff.go):
 *   BackoffDelay(attempt, base):
 *     if attempt < 0 { attempt = 0 }
 *     pure := base
 *     for i := 1; i < attempt; i++ { pure *= 2; if pure <= 0 { return base } }
 *     jitter := 0.8 + 0.4 * rand.Float64()
 *     return pure * jitter
 * Pinned by test: attempt 1=base, 2=2base, 3=4base, 4=8base (jitter pinned to 1.0).
 * Asymmetry note: bump path uses BackoffDelay(attempt, base) (delay for THIS failed
 * attempt); pre-retry sleep uses BackoffDelay(attempt-1, base). */

function BackoffDelay(attempt, base, jitterRng) {
  if (!(typeof attempt === "number") || attempt < 0) attempt = 0;
  if (!(typeof base === "number") || !Number.isFinite(base) || base <= 0) base = 100;
  let pure = base;
  for (let i = 1; i < attempt; i++) {
    pure *= 2;
    if (pure <= 0 || !Number.isFinite(pure)) return base;
  }
  const rng = typeof jitterRng === "function" ? jitterRng : Math.random;
  const jitter = 0.8 + 0.4 * rng();
  return pure * jitter;
}

/* Deterministic variant used by tests: pins jitter to 1.0 so the ladder is exact. */
function BackoffDelayPinned(attempt, base) {
  return BackoffDelay(attempt, base, () => 0.5);
}

module.exports = { BackoffDelay, BackoffDelayPinned };
