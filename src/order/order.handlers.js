"use strict";
/* order handlers — NodeJs port of GoLang internal/order/handlers.go VERBATIM.
 * CustomerRoutes (RequireAuth): GET / (own), GET /{id} (detail). AdminRoutes
 * (RequireAuth + RequireAdmin): GET / (list), POST /{id}/process. */
const express = require("express");
const httpx = require("../httpx/respond.js");
const { requireAuth, requireAdmin } = require("../httpx/auth.js");
const { RoleAdmin } = require("../auth/token.js");

function guard(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => httpx.writeError(res, err));
  };
}

// CustomerRoutes are the customer-facing order status endpoints.
function customerRoutes(svc, pool, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens));
  r.get("/", guard((req, res) => own(svc, req, res)));
  r.get("/:id", guard((req, res) => detail(svc, pool, req, res)));
  return r;
}

// AdminRoutes are the admin order-management endpoints.
function adminRoutes(svc, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens), requireAdmin);
  r.get("/", guard((req, res) => list(svc, req, res)));
  r.post("/:id/process", guard((req, res) => processRoute(svc, req, res)));
  return r;
}

async function own(svc, req, res) {
  const user = req.user;
  const views = await svc.Own(user.customer_id);
  httpx.writeOK(res, { orders: views });
}

async function list(svc, req, res) {
  const status = req.query.status || "";
  const page = n(req.query.page);
  const limit = n(req.query.limit);
  const views = await svc.List(status, page, limit);
  httpx.writeOK(res, { orders: views });
}

// detail builds a rich order view: the order lines, the payment and the
// shipment are fetched concurrently (the sample's "parallel reads" showcase).
async function detail(svc, pool, req, res) {
  const parsed = httpx.parsePathID(req, "id");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  const o = await svc.ByID(parsed.id);
  const user = req.user;
  if (o.customer_id !== user.customer_id && user.role !== RoleAdmin) {
    httpx.writeError(res, httpx.Forbidden("not allowed to view this order"));
    return;
  }

  const [items, payRow, shipRow] = await Promise.all([
    svc.Items(parsed.id),
    rowOrNull(pool, CHARGES_SQL, [parsed.id]),
    rowOrNull(pool, SHIPMENTS_SQL, [parsed.id]),
  ]);

  const view = Object.assign(o, { items });
  httpx.writeOK(res, {
    order: view,
    payment: payRow ? {
      id: payRow.id,
      status: payRow.status,
      amount_cents: Number(payRow.amount_cents),
      idempotency_key: payRow.idempotency_key,
    } : null,
    shipment: shipRow ? {
      id: shipRow.id,
      tracking_code: shipRow.tracking_code,
      courier: shipRow.courier,
      status: shipRow.status,
    } : null,
  });
}

async function processRoute(svc, req, res) {
  const parsed = httpx.parsePathID(req, "id");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const view = await svc.Process(parsed.id, in_.action ?? "");
  httpx.writeOK(res, view);
}

async function rowOrNull(pool, sql, args) {
  try {
    return await pool.queryRow(sql, args);
  } catch (err) {
    return null;
  }
}

const CHARGES_SQL =
  `SELECT id::text, status::text, amount_cents, idempotency_key
        FROM charges WHERE order_id = $1`;
const SHIPMENTS_SQL =
  `SELECT id::text, tracking_code, courier, status::text
        FROM shipments WHERE order_id = $1`;

function n(v) {
  const x = Number.parseInt(v === undefined || v === null ? "" : String(v), 10);
  return Number.isNaN(x) ? 0 : x;
}

module.exports = { customerRoutes, adminRoutes };