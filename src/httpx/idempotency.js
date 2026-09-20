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
class IdempotencyGuard {
  constructor(ttlMs, maxEntry) {
    this.store = new Map();
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
      if (key === undefined || key === "") {
        next();
        return;
      }
      // Go uses r.URL.Path (full path); Express originalUrl is the full path.
      const cacheKey = req.method + " " + req.originalUrl.split("?")[0] + " " + key;
      const now = Date.now();

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
        origEnd.call(res);
        return res;
      };
      res.on("finish", () => {
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