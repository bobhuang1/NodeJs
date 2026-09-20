"use strict";
/* shipping handlers — NodeJs port of GoLang internal/shipping/handlers.go VERBATIM.
 * CustomerRoutes mount at /api/v1/shipping (RequireAuth): GET /, GET /track,
 * GET /orders/{orderID}. AdminRoutes mount at /api/v1/admin/shipments
 * (RequireAuth + RequireAdmin): POST /, PUT /{id}. */
const express = require("express");
const httpx = require("../httpx/respond.js");
const { requireAuth, requireAdmin } = require("../httpx/auth.js");

function guard(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => httpx.writeError(res, err));
  };
}

// CustomerRoutes are the customer-facing shipping/tracking endpoints.
function customerRoutes(svc, pool, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens));
  r.get("/", guard((req, res) => own(svc, req, res)));
  r.get("/track", guard((req, res) => track(svc, req, res)));
  r.get("/orders/:orderID", guard((req, res) => byOrder(svc, pool, req, res)));
  return r;
}

// AdminRoutes are the admin fulfilment endpoints.
function adminRoutes(svc, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens), requireAdmin);
  r.post("/", guard((req, res) => ship(svc, req, res)));
  r.put("/:id", guard((req, res) => update(svc, req, res)));
  return r;
}

async function own(svc, req, res) {
  const user = req.user;
  const items = await svc.Own(user.customer_id);
  httpx.writeOK(res, { shipments: items });
}

async function track(svc, req, res) {
  const code = req.query.code || "";
  if (code === "") {
    httpx.writeError(res, httpx.BadRequest("code query parameter is required"));
    return;
  }
  const sh = await svc.Track(code);
  httpx.writeOK(res, sh);
}

async function byOrder(svc, pool, req, res) {
  const user = req.user;
  const parsed = httpx.parsePathID(req, "orderID");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  const orderID = parsed.id;
  if (!(await owns(pool, user.customer_id, orderID))) {
    httpx.writeError(res, httpx.Forbidden("not allowed to view this shipment"));
    return;
  }
  const sh = await svc.ByOrder(orderID);
  httpx.writeOK(res, sh);
}

async function ship(svc, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  if (!in_.order_id) {
    httpx.writeError(res, httpx.BadRequest("order_id is required"));
    return;
  }
  const sh = await svc.Ship(in_.order_id, in_.courier ?? "", in_.tracking_code ?? "");
  httpx.writeCreated(res, sh);
}

async function update(svc, req, res) {
  const id = req.params.id;
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const sh = await svc.Update(id, in_.tracking_code ?? "", in_.status ?? "");
  httpx.writeOK(res, sh);
}

// owns mirrors the handler's helper: only the owning customer may view a
// shipment through the order-scoped route.
async function owns(pool, customerID, orderID) {
  let res;
  try {
    res = await pool.query(`SELECT customer_id FROM orders WHERE id = $1`, [orderID]);
  } catch (err) {
    return false;
  }
  if (!res.rows || res.rows.length === 0) return false;
  return Number(res.rows[0].customer_id) === customerID;
}

module.exports = { customerRoutes, adminRoutes };