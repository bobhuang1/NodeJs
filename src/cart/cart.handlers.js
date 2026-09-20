"use strict";
/* cart handlers — NodeJs port of GoLang internal/cart/handlers.go VERBATIM
 * (route literals, response statuses, WriteError-on-error flow). Mounted at
 * "/api/v1/cart" (see internal/api/api.go r.Route("/cart")). */
const express = require("express");
const httpx = require("../httpx/respond.js");
const { requireAuth } = require("../httpx/auth.js");

// Routes are the customer-facing cart endpoints.
function routes(svc, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens));
  r.get("/", (req, res) => view(svc, req, res));
  r.delete("/", (req, res) => clear(svc, req, res));
  r.post("/items", (req, res) => add(svc, req, res));
  r.put("/items/:productID", (req, res) => update(svc, req, res));
  r.delete("/items/:productID", (req, res) => remove(svc, req, res));
  r.post("/checkout", (req, res) => checkout(svc, req, res));
  return r;
}

async function view(svc, req, res) {
  const user = req.user;
  try {
    const v = await svc.view(user.customer_id);
    httpx.writeOK(res, v);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function clear(svc, req, res) {
  const user = req.user;
  try {
    await svc.clear(user.customer_id);
    httpx.writeNoContent(res);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function add(svc, req, res) {
  const user = req.user;
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  try {
    await svc.add(user.customer_id, in_.product_id, in_.qty);
    httpx.writeCreated(res, { product_id: in_.product_id, qty: in_.qty });
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function update(svc, req, res) {
  const user = req.user;
  const parsed = httpx.parsePathID(req, "productID");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  // Go: qty <= 0 removes the line; both paths end in WriteError (204 on nil).
  try {
    if (in_.qty <= 0) {
      await svc.remove(user.customer_id, parsed.id);
    } else {
      await svc.update(user.customer_id, parsed.id, in_.qty);
    }
    httpx.writeNoContent(res);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function remove(svc, req, res) {
  const user = req.user;
  const parsed = httpx.parsePathID(req, "productID");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  try {
    await svc.remove(user.customer_id, parsed.id);
    httpx.writeNoContent(res);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function checkout(svc, req, res) {
  const user = req.user;
  const key = req.get("Idempotency-Key");
  try {
    const v = await svc.checkout(user.customer_id, key);
    httpx.writeCreated(res, v);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

module.exports = { routes };