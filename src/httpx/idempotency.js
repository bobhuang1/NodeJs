"use strict";
/* IdempotencyGuard — NodeJs port of GoLang internal/httpx/idempotency.go.
 * In-memory replay guard for requests carrying an Idempotency-Key header: the
 * first response is captured and replayed byte-for-byte for identical
 * key+method+path within a TTL window (Go: cacheKey = method + " " + path + " "
 * + key, replay sets X-Idempotent-Replay). Best-effort layer; the durable
 * guarantee is the DB unique constraints on idempotency keys.
 *
 * Express adaptation: the downstream chain is asynchronous here (Go's chi chain
 * is synchronous), so the response is captured via write()/end() interception
 * and recorded on the res 'finish' event. */
const crypto = require("node:crypto");
const { writeError, Conflict } = require("./respond.js");

class IdempotencyGuard {
  constructor(ttlMs, maxEntry) {
    this.store = new Map();
    this.inFlight = new Set();
    this.ttl = ttlMs > 0 ? ttlMs : 60000; // ttlSorrogate: <=0 -> time.Minute
    this.maxEntry = maxEntry;
    const timer = setInterval(() => this.sweep(), 2 * this.ttl);
    if (timer.unref) timer.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expires <= now) this.store.delete(k);
    }
  }

  evictLocked() {
    let oldest = Infinity;
    let victim = null;
    for (const [k, v] of this.store) {
      if (v.lastSeen < oldest) {
        oldest = v.lastSeen;
        victim = k;
      }
    }
    if (victim !== null) this.store.delete(victim);
  }

  middleware() {
    const guard = this;
    return function idempotencyMW(req, res, next) {
      const key = req.get("Idempotency-Key");
      // Only state-changing POSTs are replayed; a GET carrying the header must always
      // see fresh data.
      if (key === undefined || key === "" || req.method !== "POST") {
        next();
        return;
      }
      // Keys are chosen by clients, so the cache is partitioned by caller: without the
      // credential in the key, a second customer reusing a key would be served the
      // first customer's cached response. The token is hashed, never stored as-is.
      const caller = crypto.createHash("sha256").update(req.get("authorization") || "").digest("hex");
      const cacheKey = req.method + " " + req.originalUrl.split("?")[0] + " " + caller + " " + key;
      const now = Date.now();

      if (guard.inFlight.has(cacheKey)) {
        writeError(res, Conflict("a request with this Idempotency-Key is still being processed"));
        return;
      }

      const cached = guard.store.get(cacheKey);
      if (cached && now < cached.expires) {
        cached.lastSeen = now;
        res.set("Content-Type", "application/json; charset=utf-8");
        res.set("X-Idempotent-Replay", "true");
        res.status(cached.status);
        res.send(cached.body);
        return;
      }

      const chunks = [];
      const origWrite = res.write.bind(res);
      const origEnd = res.end.bind(res);
      res.write = (chunk) => {
        chunks.push(Buffer.from(chunk));
        return true;
      };
      res.end = (chunk) => {
        if (chunk) chunks.push(Buffer.from(chunk));
        for (const c of chunks) origWrite.call(res, c);
        origEnd.call(res);
        return res;
      };
      guard.inFlight.add(cacheKey);
      res.on("close", () => guard.inFlight.delete(cacheKey));
      res.on("finish", () => {
        guard.inFlight.delete(cacheKey);
        // Only successful outcomes are replayed; caching a failure would hand a client
        // that retries after a transient error the same error for the whole TTL.
        if (res.statusCode < 200 || res.statusCode >= 300) return;
        guard.store.set(cacheKey, {
          body: Buffer.concat(chunks),
          status: res.statusCode,
          expires: now + guard.ttl,
          lastSeen: now,
        });
        if (guard.store.size > guard.maxEntry) guard.evictLocked();
      });
      next();
    };
  }
}

module.exports = { IdempotencyGuard };