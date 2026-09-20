"use strict";
/* HTTP server — NodeJs port of cmd/server/main.go: config → pool + embedded
 * migrations → redis-or-Null cache → token manager → services → seed → router
 * → listen → graceful shutdown. IdemTTL matches main.go (10m). */
const http = require("node:http");
const path = require("node:path");
const { LeanPool } = require("./db/pool.js");
const { RunMigrations } = require("./db/migrate.js");
const config = require("./config.js");
const cache = require("./cache/redis.js");
const auth = require("./auth/token.js");
const customer = require("./customer/customer.service.js");
const product = require("./product/product.service.js");
const cart = require("./cart/cart.service.js");
const order = require("./order/order.service.js");
const payment = require("./payment/payment.service.js");
const shipping = require("./shipping/shipping.service.js");
const gateway = require("./payment/gateway.js");
const { NewRouter } = require("./app.js");
const { seed } = require("./seed.js");

// listenAddr translates a Go-style HTTP_ADDR (":8080" = all interfaces) into a
// Node listen object.
function listenAddr(addr) {
  const s = String(addr);
  if (s.startsWith(":")) return { port: Number(s.slice(1)) };
  const m = s.match(/^(.*):(\d+)$/);
  if (m) return { host: m[1] === "" ? undefined : m[1], port: Number(m[2]) };
  return { port: s };
}

async function main() {
  const pool = new LeanPool(config.databaseURL);
  try {
    await pool.ping();
  } catch (err) {
    console.error("database setup failed", err);
    process.exit(1);
  }
  await RunMigrations(pool, path.join(__dirname, "db", "migrations"));

  // The cache: Redis preferred; when unreachable the service starts degraded
  // (No-op cache) exactly like main.go's 500ms-ping fallback.
  let cacheStore = cache.newCache(config.redisAddr, config.redisPassword);
  const pinged = await Promise.race([
    cacheStore.ping().then(() => true, () => false),
    new Promise((r) => setTimeout(() => r(false), 500)),
  ]);
  if (!pinged) {
    console.warn("redis unreachable, starting with no-op cache (degraded)", config.redisAddr);
    try { cacheStore.client.disconnect(); } catch (_) { /* best-effort */ }
    cacheStore = cache.Null;
  } else {
    console.log("redis connected", config.redisAddr);
  }

  const tokens = new auth.TokenManager(config.jwtSecret, config.jwtTTLMinutes, config.jwtChallengeTTLMinutes);

  const customers = new customer.Service(pool, cacheStore);
  const products = new product.Service(pool, cacheStore);
  const carts = new cart.Service(pool, products);
  const orders = new order.Service(pool);
  const gw = gateway.NewStubGateway();
  const payments = new payment.Service(pool, cacheStore, gw, config.maxPaymentAttempts, config.paymentRetryBaseDelayMs);
  const shippings = new shipping.Service(pool);

  await seed(pool, products);

  const app = NewRouter({
    pool,
    cache: cacheStore,
    tokens,
    customers,
    products,
    carts,
    orders,
    payments,
    shippings,
    idemTTL: config.idemTTL, // 10 * time.Minute
  });

  const server = http.createServer(app);
  server.listen(listenAddr(config.httpAddr), () => {
    console.log("server listening", config.httpAddr);
  });

  const shutdown = () => {
    const force = setTimeout(() => process.exit(1), 10 * 1000);
    force.unref();
    server.close(async () => {
      try { if (cacheStore && typeof cacheStore.close === "function") await cacheStore.close(); } catch (_) { /* best-effort */ }
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