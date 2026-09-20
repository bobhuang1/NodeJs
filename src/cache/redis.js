"use strict";
/* Redis cache seam — NodeJs port of GoLang internal/cache/redis.go. Surface:
 *   get(key) → Buffer | throws ErrMiss
 *   set(key, value, ttlMs) → void
 *   del(...keys) → void
 * Every op runs through the shared makeRetry wrapper (cache.js) with go-redis'
 * default Options (maxAttempts 3, baseDelay 40ms, opTimeout 500ms). Redis is
 * never a source of truth: callers degrade to PostgreSQL, exactly like Go. */
const { Redis } = require("ioredis");
const { makeRetry } = require("./cache.js");

// ErrMiss reports a cache read that did not hit (errors.Is(cache.ErrMiss)).
const ErrMiss = Object.assign(new Error("cache miss"), { cacheMiss: true });

function isMiss(err) {
  return !!(err && err.cacheMiss === true);
}

function defaultOptions() {
  return { maxAttempts: 3, baseDelay: 40, opTimeout: 500 };
}

function parseAddr(addr) {
  const parts = String(addr || "localhost:6379").split(":");
  return {
    host: parts[0] || "localhost",
    port: parts[1] ? Number(parts[1]) : 6379,
  };
}

function newCache(addr, password, opts = {}) {
  const target = parseAddr(addr);
  const client = new Redis({
    host: target.host,
    port: target.port,
    password: password || undefined,
    lazyConnect: false,
  });
  const o = Object.assign(defaultOptions(), opts);
  const retry = makeRetry(o);

  // go-redis: miss skips the retry loop's "non-transient throws" only after
  // mapping redis.Nil -> ErrMiss; here ioredis returns null for a miss.
  async function get(key) {
    const val = await retry(async () => client.get(key), "get");
    if (val === null || val === undefined) throw ErrMiss;
    return Buffer.from(val);
  }

  async function set(key, value, ttlMs) {
    const ms = ttlMs > 0 ? ttlMs : 0;
    const secs = Math.max(1, Math.round(ms / 1000));
    await retry(async () => client.set(key, value, "EX", secs), "set");
  }

  async function del(...keys) {
    await retry(async () => client.del(...keys), "del");
  }

  return {
    client,
    get,
    set,
    del,
    async ping() {
      return client.ping();
    },
    async close() {
      await client.quit();
    },
  };
}

// Null is a no-op cache: every op succeeds and reads always miss (degraded).
const Null = {
  async get() { throw ErrMiss; },
  async set() {},
  async del() {},
};

module.exports = { ErrMiss, isMiss, defaultOptions, parseAddr, newCache, Null };