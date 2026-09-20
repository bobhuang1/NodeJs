"use strict";
/* product handlers — NodeJs port of GoLang internal/product/handlers.go VERBATIM
 * (route literals, response statuses). PublicRoutes mount at "/api/v1/products",
 * AdminRoutes at "/api/v1/admin/products" (see internal/api/api.go). */
const express = require("express");
const httpx = require("../httpx/respond.js");
const { requireAuth, requireAdmin } = require("../httpx/auth.js");

// PublicRoutes are the customer-facing product endpoints.
function publicRoutes(svc) {
  const r = express.Router();
  r.get("/", (req, res) => list(svc, req, res));
  r.get("/:id", (req, res) => get(svc, req, res));
  return r;
}

// AdminRoutes are the admin product-management endpoints.
function adminRoutes(svc, tokens) {
  const r = express.Router();
  r.use(requireAuth(tokens), requireAdmin);
  r.post("/", (req, res) => create(svc, req, res));
  r.put("/:id", (req, res) => update(svc, req, res));
  r.delete("/:id", (req, res) => remove(svc, req, res));
  return r;
}

function numQuery(v) {
  const n = Number.parseInt(String(v === undefined ? "" : v), 10);
  return Number.isNaN(n) ? 0 : n;
}

function toCreate(in_) {
  return {
    sku: in_.sku ?? "",
    name: in_.name ?? "",
    description: in_.description ?? "",
    price_cents: in_.price_cents ?? 0,
    currency: in_.currency ?? "",
    stock: in_.stock ?? 0,
  };
}

async function list(svc, req, res) {
  const page = numQuery(req.query.page);
  const limit = numQuery(req.query.limit);
  const q = req.query.q || "";
  try {
    const items = await svc.list(page, limit, q);
    httpx.writeOK(res, { products: items });
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function get(svc, req, res) {
  const parsed = httpx.parsePathID(req, "id");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  try {
    const p = await svc.get(parsed.id);
    httpx.writeOK(res, p);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function create(svc, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const body = toCreate(in_);
  try {
    const p = await svc.create(body.sku, body.name, body.description, body.currency, body.price_cents, body.stock);
    httpx.writeCreated(res, p);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function update(svc, req, res) {
  const parsed = httpx.parsePathID(req, "id");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  try {
    const p = await svc.update(parsed.id, in_);
    httpx.writeOK(res, p);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

async function remove(svc, req, res) {
  const parsed = httpx.parsePathID(req, "id");
  if (!parsed.ok) {
    httpx.writeError(res, parsed.err);
    return;
  }
  try {
    await svc.deactivate(parsed.id);
    httpx.writeNoContent(res);
  } catch (err) {
    httpx.writeError(res, err);
  }
}

module.exports = { publicRoutes, adminRoutes };