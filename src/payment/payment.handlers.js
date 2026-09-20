"use strict";
/* payment handlers — NodeJs port of GoLang internal/payment/handlers.go VERBATIM.
 * CustomerRoutes mount at /api/v1/payments (IdempotencyGuard + RequireAuth):
 * GET/POST /charges, GET /charges/{id}, POST/GET /refunds. AdminRoutes mount at
 * /api/v1/admin/refunds (IdempotencyGuard + RequireAuth + RequireAdmin): POST /. */
const express = require("express");
const httpx = require("../httpx/respond.js");
const { requireAuth, requireAdmin } = require("../httpx/auth.js");
const { IdempotencyGuard } = require("../httpx/idempotency.js");
const { RoleAdmin } = require("../auth/token.js");

function guard(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => httpx.writeError(res, err));
  };
}

// idemKey mirrors the Go helper: the header is mandatory on charging routes.
function idemKey(req, res) {
  const k = req.get("Idempotency-Key");
  if (k === undefined || k === "") {
    httpx.writeError(res, httpx.BadRequest("Idempotency-Key header is required"));
    return null;
  }
  return k;
}

// CustomerRoutes are the caller-facing payment endpoints.
function customerRoutes(svc, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens));
  r.get("/charges", guard((req, res) => myCharges(svc, req, res)));
  r.post("/charges", guard((req, res) => charge(svc, req, res)));
  r.get("/charges/:id", guard((req, res) => getCharge(svc, req, res)));
  r.post("/refunds", guard((req, res) => refund(svc, req, res)));
  r.get("/refunds", guard((req, res) => myRefunds(svc, req, res)));
  return r;
}

// AdminRoutes are the admin payment-management endpoints (refund processing).
function adminRoutes(svc, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens), requireAdmin);
  r.post("/", guard((req, res) => adminRefund(svc, req, res)));
  return r;
}

async function charge(svc, req, res) {
  const key = idemKey(req, res);
  if (key === null) return;
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  if (!in_.order_id) {
    httpx.writeError(res, httpx.BadRequest("order_id is required"));
    return;
  }
  const user = req.user;
  const c = await svc.Charge(in_.order_id, user.customer_id, key, in_.simulate ?? "");
  httpx.writeCreated(res, omitEmpty(c));
}

async function myCharges(svc, req, res) {
  const user = req.user;
  const items = await svc.MyCharges(user.customer_id);
  httpx.writeOK(res, { charges: items.map(omitEmpty) });
}

async function getCharge(svc, req, res) {
  const parsed = httpx.parsePathUUID(req, "id");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  const user = req.user;
  const c = await svc.ChargeByID(parsed.value, user.customer_id, user.role === RoleAdmin);
  httpx.writeOK(res, omitEmpty(c));
}

// refund is the customer-initiated refund route.
async function refund(svc, req, res) {
  const key = idemKey(req, res);
  if (key === null) return;
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  if (!in_.order_id) {
    httpx.writeError(res, httpx.BadRequest("order_id is required"));
    return;
  }
  const user = req.user;
  const r = await svc.Refund(in_.order_id, user.customer_id, in_.amount_cents ?? 0, key, in_.reason ?? "", false);
  httpx.writeCreated(res, omitEmpty(r));
}

async function myRefunds(svc, req, res) {
  const user = req.user;
  const items = await svc.MyRefunds(user.customer_id);
  httpx.writeOK(res, { refunds: items.map(omitEmpty) });
}

// adminRefund is the admin-initiated refund route.
async function adminRefund(svc, req, res) {
  const key = idemKey(req, res);
  if (key === null) return;
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  if (!in_.order_id) {
    httpx.writeError(res, httpx.BadRequest("order_id is required"));
    return;
  }
  const user = req.user;
  const r = await svc.Refund(in_.order_id, user.customer_id, in_.amount_cents ?? 0, key, in_.reason ?? "", true);
  httpx.writeCreated(res, omitEmpty(r));
}

// omitEmpty mirrors Go's omitempty tags (drop empty strings/undefined fields).
function omitEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === "" || v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

// guardMiddleware mounts the in-memory replay guard like api.go does.
function guardMiddleware(idemTTL, maxEntries) {
  return new IdempotencyGuard(idemTTL, maxEntries).middleware();
}

module.exports = { customerRoutes, adminRoutes, guardMiddleware, omitEmpty };