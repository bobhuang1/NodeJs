"use strict";
/* shipping test — the 5 route literals of GoLang internal/shipping/handlers.go
 * (mounted under /api/v1/shipping + /api/v1/admin/shipments) plus the service
 * flows: ship transitions the order, illegal status/value/transtion guards. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { serve } = require("../../test/http.js");
const { memPool } = require("../../test/db/pgmem.js");
const { Service } = require("../../src/shipping/shipping.service.js");
const { customerRoutes, adminRoutes } = require("../../src/shipping/shipping.handlers.js");
const { TokenManager } = require("../../src/auth/token.js");

const tm = new TokenManager("shipping-test-secret", 60, 5);
const userTok = tm.sign(7, "a@b.com", "customer");
const otherTok = tm.sign(9, "c@d.com", "customer");
const adminTok = tm.sign(1, "admin@example.com", "admin");

const WHEN = new Date("2026-09-19T00:00:00Z");
const UUID_SHIP = "33333333-3333-3333-3333-333333333333";

const SHIPMENT_COLS = "id::text, order_id, tracking_code, courier, status, created_at, updated_at";
const ORDERS_FOR_UPDATE = `SELECT status, version FROM orders WHERE id = $1 FOR UPDATE`;
const INSERT_SHIP = `INSERT INTO shipments (order_id, tracking_code, courier, status)
        VALUES ($1,$2,$3,'pending')
        RETURNING ${SHIPMENT_COLS}`;
const UPDATE_ORDER_SHIPPED = `UPDATE orders SET status = 'shipped', version = version + 1, updated_at = now()
        WHERE id = $1 AND status = $2 AND version = $3`;
const SEL_SHIP_BY_ID = `SELECT ${SHIPMENT_COLS}
        FROM shipments WHERE id = $1::uuid FOR UPDATE`;
const UPDATE_SHIP = `UPDATE shipments SET status = $2::shipment_status, tracking_code = $3,
               updated_at = now()
        WHERE id = $1::uuid`;
const UPDATE_ORDER_DELIVERED = `UPDATE orders SET status = 'delivered', version = version + 1, updated_at = now()
        WHERE id = $1 AND status = 'shipped'`;
const SEL_SHIP_BY_ORDER = `SELECT ${SHIPMENT_COLS}
        FROM shipments WHERE order_id = $1`;
const OWN = `SELECT s.${SHIPMENT_COLS}
        FROM shipments s JOIN orders o ON o.id = s.order_id
        WHERE o.customer_id = $1 ORDER BY s.created_at DESC`;
const TRACK = `SELECT ${SHIPMENT_COLS}
        FROM shipments WHERE tracking_code = $1`;
const OWNS = `SELECT customer_id FROM orders WHERE id = $1`;

function shipRow(status, tracking = "TRACK123") {
  return {
    id: UUID_SHIP, order_id: "10", tracking_code: tracking, courier: "dhl",
    status, created_at: WHEN, updated_at: WHEN,
  };
}

function appFor(svc, pool) {
  const app = express();
  app.use("/api/v1/shipping", customerRoutes(svc, pool, tm));
  app.use("/api/v1/admin/shipments", adminRoutes(svc, tm));
  return app;
}

test("shipping route literals: own/track/byOrder + admin ship/update under /api/v1", async () => {
  const pool = memPool();
  const svc = new Service(pool);
  const srv = await serve(appFor(svc, pool));
  try {
    const auth = { Authorization: "Bearer " + userTok };

    const noAuth = await fetch(srv.base + "/api/v1/shipping");
    assert.equal(noAuth.status, 401);

    pool.expectSQL(OWN, { args: [7], rows: [] });
    const own = await fetch(srv.base + "/api/v1/shipping", { headers: auth });
    assert.equal(own.status, 200);
    assert.deepEqual(await own.json(), { shipments: [] });

    const noCode = await fetch(srv.base + "/api/v1/shipping/track", { headers: auth });
    assert.equal(noCode.status, 400);
    assert.deepEqual((await noCode.json()).error, { code: "bad_request", message: "code query parameter is required" });

    pool.expectSQL(TRACK, { args: ["TRACK123"], rows: [shipRow("in_transit")] });
    const tracked = await fetch(srv.base + "/api/v1/shipping/track?code=TRACK123", { headers: auth });
    assert.equal(tracked.status, 200);
    const trackedBody = await tracked.json();
    assert.equal(trackedBody.id, UUID_SHIP);
    assert.equal(trackedBody.order_id, 10);
    assert.equal(trackedBody.tracking_code, "TRACK123");
    assert.equal(trackedBody.courier, "dhl");
    assert.equal(trackedBody.status, "in_transit");

    pool.expectSQL(OWNS, { args: [10], rows: [{ customer_id: "7" }] });
    pool.expectSQL(SEL_SHIP_BY_ORDER, { args: [10], rows: [shipRow("delivered")] });
    const byOrder = await fetch(srv.base + "/api/v1/shipping/orders/10", { headers: auth });
    assert.equal(byOrder.status, 200);
    assert.equal((await byOrder.json()).status, "delivered");

    pool.expectSQL(OWNS, { args: [10], rows: [{ customer_id: "7" }] });
    const other = await fetch(srv.base + "/api/v1/shipping/orders/10", { headers: { Authorization: "Bearer " + otherTok } });
    assert.equal(other.status, 403);
    assert.deepEqual((await other.json()).error, { code: "forbidden", message: "not allowed to view this shipment" });

    const notAdmin = await fetch(srv.base + "/api/v1/admin/shipments", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, auth),
      body: JSON.stringify({ order_id: 10, courier: "dhl", tracking_code: "TRACK123" }),
    });
    assert.equal(notAdmin.status, 403);
    assert.deepEqual((await notAdmin.json()).error, { code: "forbidden", message: "administrator role required" });

    pool.expectSQL(ORDERS_FOR_UPDATE, { args: [10], rows: [{ status: "paid", version: "5" }] });
    pool.expectSQL(INSERT_SHIP, { args: [10, "TRACK123", "dhl"], rows: [shipRow("pending")] });
    pool.expectSQL(UPDATE_ORDER_SHIPPED, { args: [10, "paid", 5] });
    const ship = await fetch(srv.base + "/api/v1/admin/shipments", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ order_id: 10, courier: "dhl", tracking_code: "TRACK123" }),
    });
    assert.equal(ship.status, 201);
    const shipBody = await ship.json();
    assert.equal(shipBody.id, UUID_SHIP);
    assert.equal(shipBody.status, "pending");

    pool.expectSQL(ORDERS_FOR_UPDATE, { args: [12], rows: [{ status: "cancelled", version: "5" }] });
    const badShip = await fetch(srv.base + "/api/v1/admin/shipments", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ order_id: 12, courier: "dhl", tracking_code: "TRACK9" }),
    });
    assert.equal(badShip.status, 409);
    assert.deepEqual((await badShip.json()).error, { code: "conflict", message: "order must be paid or processing before shipping" });
  } finally {
    await srv.close();
  }
});

test("shipping update: transition machine (illegal move 409, delivered moves order)", async () => {
  const pool = memPool();
  const svc = new Service(pool);
  const srv = await serve(appFor(svc, pool));
  try {
    const adminAuth = { "Content-Type": "application/json", Authorization: "Bearer " + adminTok };

    const badValue = await fetch(srv.base + "/api/v1/admin/shipments/" + UUID_SHIP, {
      method: "PUT",
      headers: adminAuth,
      body: JSON.stringify({ status: "flying", tracking_code: "" }),
    });
    assert.equal(badValue.status, 400);
    assert.deepEqual((await badValue.json()).error, { code: "bad_request", message: "unknown shipment status" });

    pool.expectSQL(SEL_SHIP_BY_ID, { args: [UUID_SHIP], rows: [shipRow("pending")] });
    const illegal = await fetch(srv.base + "/api/v1/admin/shipments/" + UUID_SHIP, {
      method: "PUT",
      headers: adminAuth,
      body: JSON.stringify({ status: "delivered", tracking_code: "" }),
    });
    assert.equal(illegal.status, 409);
    assert.deepEqual((await illegal.json()).error, { code: "conflict", message: "invalid shipment status transition" });

    pool.expectSQL(SEL_SHIP_BY_ID, { args: [UUID_SHIP], rows: [shipRow("picked")] });
    pool.expectSQL(UPDATE_SHIP, { args: [UUID_SHIP, "in_transit", "TRACK456"] });
    const advance = await fetch(srv.base + "/api/v1/admin/shipments/" + UUID_SHIP, {
      method: "PUT",
      headers: adminAuth,
      body: JSON.stringify({ status: "in_transit", tracking_code: "TRACK456" }),
    });
    assert.equal(advance.status, 200, "advance body: " + await advance.clone().text());
    const advanceBody = await advance.json();
    assert.equal(advanceBody.status, "in_transit");
    assert.equal(advanceBody.tracking_code, "TRACK456");

    pool.expectSQL(SEL_SHIP_BY_ID, { args: [UUID_SHIP], rows: [shipRow("in_transit")] });
    pool.expectSQL(UPDATE_SHIP, { args: [UUID_SHIP, "delivered", "TRACK456"] });
    pool.expectSQL(UPDATE_ORDER_DELIVERED, { args: [10] });
    const done = await fetch(srv.base + "/api/v1/admin/shipments/" + UUID_SHIP, {
      method: "PUT",
      headers: adminAuth,
      body: JSON.stringify({ status: "delivered", tracking_code: "TRACK456" }),
    });
    assert.equal(done.status, 200);
    assert.equal((await done.json()).status, "delivered");
  } finally {
    await srv.close();
  }
});

test("shipping missing or absent values: order not found / no shipment / bad ship args", async () => {
  const pool = memPool();
  const svc = new Service(pool);
  const adminAuth = { "Content-Type": "application/json", Authorization: "Bearer " + adminTok };

  await assert.rejects(
    svc.Ship(10, "", ""),
    (err) => err.status === 400 && err.message === "courier and tracking_code are required"
  );

  pool.expectSQL(ORDERS_FOR_UPDATE, { args: [99], rows: [] });
  await assert.rejects(
    svc.Ship(99, "dhl", "TRACK9"),
    (err) => err.status === 404 && err.message === "order not found"
  );

  pool.expectSQL(SEL_SHIP_BY_ORDER, { args: [99], rows: [] });
  await assert.rejects(
    svc.ByOrder(99),
    (err) => err.status === 404 && err.message === "no shipment for this order"
  );

  pool.expectSQL(TRACK, { args: ["NOPE"], rows: [] });
  await assert.rejects(
    svc.Track("NOPE"),
    (err) => err.status === 404 && err.message === "tracking code not found"
  );
});