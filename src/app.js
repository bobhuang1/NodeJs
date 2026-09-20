"use strict";
/* Router assembly — NodeJs port of GoLang internal/api/api.go NewRouter 1:1.
 * Middleware stack in order: RequestIDMW, RecoverMW, LoggerMW; then /healthz;
 * then the route groups under /api/v1. One shared IdempotencyGuard wraps cart,
 * payments and admin/refunds exactly like api.go. Handlers decode bodies
 * themselves (src/httpx/respond.js decodeJSON), so no express.json() body
 * parser is mounted. */
const crypto = require("node:crypto");
const express = require("express");
const { IdempotencyGuard } = require("./httpx/idempotency.js");
const { writeJSON } = require("./httpx/respond.js");
const customer = require("./customer/customer.handlers.js");
const product = require("./product/product.handlers.js");
const cart = require("./cart/cart.handlers.js");
const order = require("./order/order.handlers.js");
const payment = require("./payment/payment.handlers.js");
const shipping = require("./shipping/shipping.handlers.js");

// RequestIDMW mirrors httpx.RequestIDMW: honour an inbound X-Request-Id or
// mint a random hex one, echoed back on the response.
function requestIDMW(req, res, next) {
  const id = req.get("X-Request-Id") || crypto.randomBytes(8).toString("hex");
  res.set("X-Request-Id", id);
  req.requestID = id;
  next();
}

// RecoverMW mirrors httpx.RecoverMW: panics become 500s with the stack logged.
function recoverMW(req, res, next) {
  try {
    next();
  } catch (err) {
    console.error("panic recovered", {
      request_id: req.requestID,
      path: req.originalUrl,
      panic: err && err.message ? err.message : String(err),
      stack: err && err.stack,
    });
    writeJSON(res, 500, { error: { code: "internal", message: "internal error" } });
  }
}

// LoggerMW mirrors httpx.LoggerMW: one info line per request.
function loggerMW(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    console.log("http request", JSON.stringify({
      request_id: req.requestID,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    }));
  });
  next();
}

// NewRouter assembles the full HTTP app. Deps mirrors api.Deps.
function NewRouter(deps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestIDMW, recoverMW, loggerMW);

  // healthz probes the pool with a 2s budget (Go: context timeout).
  app.get("/healthz", (req, res) => {
    const timer = setTimeout(() => {
      writeJSON(res, 500, { error: { code: "internal", message: "database unreachable" } });
    }, 2000);
    deps.pool.ping().then(
      () => { clearTimeout(timer); writeJSON(res, 200, { status: "ok" }); },
      () => { clearTimeout(timer); writeJSON(res, 500, { error: { code: "internal", message: "database unreachable" } }); }
    );
  });

  // In-memory replay guard (Go: NewIdempotencyGuard(d.IdemTTL, 1000), shared).
  const guard = new IdempotencyGuard(deps.idemTTL, 1000);
  const idem = guard.middleware();

  const api = express.Router();

  // ---- auth + customers (mounts /auth, /customers itself) ----
  api.use(customer.routes(deps.customers, deps.tokens));

  // ---- products ----
  api.use("/products", product.publicRoutes(deps.products));
  api.use("/admin/products", product.adminRoutes(deps.products, deps.tokens));

  // ---- cart ----
  api.use("/cart", idem, cart.routes(deps.carts, deps.tokens));

  // ---- orders ----
  api.use("/orders", order.customerRoutes(deps.orders, deps.pool, deps.tokens));
  api.use("/admin/orders", order.adminRoutes(deps.orders, deps.tokens));

  // ---- payments ----
  api.use("/payments", idem, payment.customerRoutes(deps.payments, deps.tokens));
  api.use("/admin/refunds", idem, payment.adminRoutes(deps.payments, deps.tokens));

  // ---- shipping ----
  api.use("/shipping", shipping.customerRoutes(deps.shippings, deps.pool, deps.tokens));
  api.use("/admin/shipments", shipping.adminRoutes(deps.shippings, deps.tokens));

  app.use("/api/v1", api);

  // Last-resort error handler (async failures are caught by per-handler guards).
  app.use((err, req, res, next) => {
    if (res.headersSent) { next(err); return; }
    writeJSON(res, 500, { error: { code: "internal", message: "internal error" } });
  });

  return app;
}

module.exports = { NewRouter };