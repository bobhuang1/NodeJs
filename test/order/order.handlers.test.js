"use strict";
/* order test — the 4 route literals of GoLang internal/order/handlers.go plus
 * the concurrency-safe Process state machine (FOR UPDATE + version bump). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { serve } = require("../../test/http.js");
const { memPool } = require("../../test/db/pgmem.js");
const { Service } = require("../../src/order/order.service.js");
const { customerRoutes, adminRoutes } = require("../../src/order/order.handlers.js");
const { TokenManager } = require("../../src/auth/token.js");

const tm = new TokenManager("order-test-secret", 60, 5);
const userTok = tm.sign(7, "a@b.com", "customer");
const otherTok = tm.sign(9, "c@d.com", "customer");
const adminTok = tm.sign(1, "admin@example.com", "admin");

const WHEN = new Date("2026-09-19T00:00:00Z");
const ORDER_SELECT =
  `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders WHERE id = $1`;
const PROCESS_SELECT =
  `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders WHERE id = $1 FOR UPDATE`;
const PROCESS_UPDATE =
  `UPDATE orders SET status = $2, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $3`;
const OWN_SELECT =
  `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders WHERE customer_id = $1 ORDER BY id DESC`;
const LIST_SELECT =
  `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders
        WHERE $3 = '' OR status = $3::order_status
        ORDER BY id DESC
        LIMIT $1 OFFSET $2`;
const ITEMS_SELECT =
  `SELECT product_id, product_name, unit_price_cents, qty
        FROM order_items WHERE order_id = $1 ORDER BY product_id`;
const CHARGES_SELECT =
  `SELECT id::text, status::text, amount_cents, idempotency_key
        FROM charges WHERE order_id = $1`;
const SHIPMENTS_SELECT =
  `SELECT id::text, tracking_code, courier, status::text
        FROM shipments WHERE order_id = $1`;

const ORDER_ROW = {
  id: "10", customer_id: "7", status: "paid", total_cents: "5000", currency: "usd",
  version: 2, created_at: WHEN, updated_at: WHEN,
};
const ORDER_JSON = {
  id: 10, customer_id: 7, status: "paid", total_cents: 5000, currency: "usd",
  version: 2, created_at: WHEN.toJSON(), updated_at: WHEN.toJSON(),
};
const ITEM_ROW = { product_id: "3", product_name: "Widget", unit_price_cents: "5000", qty: 1 };
const ITEM_JSON = { product_id: 3, product_name: "Widget", unit_price_cents: 5000, qty: 1 };

function appFor(svc, pool) {
  const app = express();
  app.use("/api/v1/orders", customerRoutes(svc, pool, tm));
  app.use("/api/v1/admin/orders", adminRoutes(svc, tm));
  return app;
}

test("order route literals: own / detail(+payment+shipment) / list / process", async () => {
  const pool = memPool();
  const svc = new Service(pool);
  const srv = await serve(appFor(svc, pool));
  try {
    const auth = { Authorization: "Bearer " + userTok };

    pool.expectSQL(OWN_SELECT, { args: [7], rows: [ORDER_ROW] });
    pool.expectSQL(ITEMS_SELECT, { args: [10], rows: [ITEM_ROW] });
    const own = await fetch(srv.base + "/api/v1/orders", { headers: auth });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { orders: [Object.assign({}, ORDER_JSON, { items: [ITEM_JSON] })] });

    pool.expectSQL(ORDER_SELECT, { args: [10], rows: [ORDER_ROW] });
    pool.expectSQL(ITEMS_SELECT, { args: [10], rows: [ITEM_ROW] });
    pool.expectSQL(CHARGES_SELECT, { args: [10], rows: [{ id: "ch_9", status: "succeeded", amount_cents: "5000", idempotency_key: "pay_123" }] });
    pool.expectSQL(SHIPMENTS_SELECT, { args: [10], rows: [{ id: "sh_2", tracking_code: "TRK1", courier: "fedex", status: "in_transit" }] });
    const detail = await fetch(srv.base + "/api/v1/orders/10", { headers: auth });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.deepEqual(detailBody.order, Object.assign({}, ORDER_JSON, { items: [ITEM_JSON] }));
    assert.deepEqual(detailBody.payment, { id: "ch_9", status: "succeeded", amount_cents: 5000, idempotency_key: "pay_123" });
    assert.deepEqual(detailBody.shipment, { id: "sh_2", tracking_code: "TRK1", courier: "fedex", status: "in_transit" });

    pool.expectSQL(ORDER_SELECT, { args: [10], rows: [ORDER_ROW] });
    const forbidden = await fetch(srv.base + "/api/v1/orders/10", { headers: { Authorization: "Bearer " + otherTok } });
    assert.equal(forbidden.status, 403);
    assert.deepEqual((await forbidden.json()).error, { code: "forbidden", message: "not allowed to view this order" });

    const noAuth = await fetch(srv.base + "/api/v1/orders");
    assert.equal(noAuth.status, 401);

    pool.expectSQL(LIST_SELECT, { args: [20, 0, ""], rows: [ORDER_ROW] });
    const list = await fetch(srv.base + "/api/v1/admin/orders", { headers: { Authorization: "Bearer " + adminTok } });
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { orders: [Object.assign({}, ORDER_JSON, { items: null })] });

    const notAdmin = await fetch(srv.base + "/api/v1/admin/orders", { headers: auth });
    assert.equal(notAdmin.status, 403);
    assert.deepEqual((await notAdmin.json()).error, { code: "forbidden", message: "administrator role required" });

    pool.expectSQL(PROCESS_SELECT, { args: [10], rows: [ORDER_ROW] });
    pool.expectSQL(PROCESS_UPDATE, { args: [10, "processing", 2], rowCount: 1 });
    const process = await fetch(srv.base + "/api/v1/admin/orders/10/process", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ action: "confirm" }),
    });
    assert.equal(process.status, 200);
    assert.deepEqual(await process.json(), Object.assign({}, ORDER_JSON, { status: "processing", version: 3, items: null }));

    const bad = await fetch(srv.base + "/api/v1/admin/orders/10/process", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ action: "bogus" }),
    });
    assert.equal(bad.status, 400);
    assert.deepEqual((await bad.json()).error, { code: "bad_request", message: "unknown action; allowed: confirm, cancel" });
  } finally {
    await srv.close();
  }
});

test("process: illegal transition is a 409 conflict after the row lock", async () => {
  const pool = memPool();
  const svc = new Service(pool);
  const srv = await serve(appFor(svc, pool));
  try {
    const delivered = Object.assign({}, ORDER_ROW, { status: "delivered" });
    pool.expectSQL(PROCESS_SELECT, { args: [10], rows: [delivered] });
    const cancel = await fetch(srv.base + "/api/v1/admin/orders/10/process", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ action: "cancel" }),
    });
    assert.equal(cancel.status, 409);
    assert.deepEqual((await cancel.json()).error, { code: "conflict", message: "cannot cancel an order in status delivered" });
  } finally {
    await srv.close();
  }
});