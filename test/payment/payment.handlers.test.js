"use strict";
/* payment test — the 6 route literals of GoLang internal/payment/handlers.go
 * (mounted under /api/v1/payments and /api/v1/admin/refunds) plus the service
 * flows: happy charge, permanent decline (422 payment_declined), the
 * restart-after-transient path, and refunds. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { serve } = require("../../test/http.js");
const { memPool } = require("../../test/db/pgmem.js");
const { Service, CHARGE_COLS } = require("../../src/payment/payment.service.js");
const { customerRoutes, adminRoutes, guardMiddleware } = require("../../src/payment/payment.handlers.js");
const { NewStubGateway } = require("../../src/payment/gateway.js");
const { TokenManager } = require("../../src/auth/token.js");
const { ErrMiss } = require("../../src/cache/redis.js");

const tm = new TokenManager("payment-test-secret", 60, 5);
const userTok = tm.sign(7, "a@b.com", "customer");
const otherTok = tm.sign(9, "c@d.com", "customer");
const adminTok = tm.sign(1, "admin@example.com", "admin");

const WHEN = new Date("2026-09-19T00:00:00Z");
const UUID_CHARGE = "11111111-1111-1111-1111-111111111111";
const UUID_REFUND = "22222222-2222-2222-2222-222222222222";

const SELECT_CHARGES_BY_ORDER =
  `SELECT ${CHARGE_COLS} FROM charges WHERE order_id = $1`;
const CHARGES_BY_ID =
  `SELECT ${CHARGE_COLS} FROM charges WHERE id = $1::uuid`;
const MY_CHARGES =
  `SELECT ${CHARGE_COLS} FROM charges WHERE customer_id = $1 ORDER BY created_at DESC`;
const ORDERS_FOR_UPDATE =
  `SELECT status, total_cents, currency FROM orders
            WHERE id = $1 FOR UPDATE`;
const INSERT_CHARGE =
  `INSERT INTO charges (order_id, customer_id, amount_cents, currency, idempotency_key)
            VALUES ($1,$2,$3,$4,$5)
            RETURNING id::text`;
const UPDATE_CHARGE_SUCCEEDED =
  `UPDATE charges SET status = 'succeeded', provider_charge_id = $2, updated_at = now()
            WHERE id = $1::uuid AND status = 'pending'`;
const UPDATE_ORDER_PAID =
  `UPDATE orders SET status = 'paid', version = version + 1, updated_at = now()
            WHERE id = $1 AND status = 'pending'`;
const UPDATE_CHARGE_FAILED =
  `UPDATE charges SET status = 'failed', failure_reason = $2, updated_at = now()
            WHERE id = $1::uuid`;
const UPDATE_CHARGE_TRANSIENT =
  `UPDATE charges SET failure_reason = $2, updated_at = now()
            WHERE id = $1::uuid AND status = 'pending'`;
const REFUNDED_TOTAL =
  `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'succeeded'), 0)
            FROM refunds WHERE charge_id = $1::uuid`;
const SELECT_REFUND_BY_KEY =
  `SELECT r.id::text, r.charge_id::text, c.order_id, r.customer_id, r.amount_cents, r.status,
               r.provider_refund_id, r.failure_reason, r.idempotency_key, r.created_at
            FROM refunds r JOIN charges c ON c.id = r.charge_id
            WHERE r.idempotency_key = $1`;
const MY_REFUNDS =
  `SELECT r.id::text, r.charge_id::text, c.order_id, r.customer_id, r.amount_cents, r.status,
               r.provider_refund_id, r.failure_reason, r.idempotency_key, r.created_at
            FROM refunds r JOIN charges c ON c.id = r.charge_id
            WHERE r.customer_id = $1 ORDER BY r.created_at DESC`;
const INSERT_REFUND =
  `INSERT INTO refunds (charge_id, customer_id, amount_cents, idempotency_key)
            VALUES ($1::uuid, $2, $3, $4)
            RETURNING id::text`;
const UPDATE_REFUND_SUCCEEDED =
  `UPDATE refunds SET status = 'succeeded', provider_refund_id = $2, updated_at = now()
            WHERE id = $1::uuid`;
const UPDATE_CHARGE_REFUNDED =
  `UPDATE charges SET
            status = CASE WHEN (
              COALESCE((SELECT SUM(amount_cents) FILTER (WHERE status = 'succeeded') FROM refunds WHERE charge_id = $1::uuid), 0)
              >= amount_cents
            ) THEN 'refunded' ELSE status END,
            updated_at = now()
            WHERE id = $1::uuid`;

// MemCache mirrors the Redis seam: miss -> ErrMiss, values as Buffers.
class MemCache {
  constructor() { this.m = new Map(); }
  async get(k) { if (!this.m.has(k)) throw ErrMiss; return this.m.get(k); }
  async set(k, v) { this.m.set(k, Buffer.from(v)); }
  async del(k) { this.m.delete(k); }
}

const PENDING_CHARGE_ROW = {
  id: UUID_CHARGE, order_id: "10", customer_id: "7", amount_cents: "5000", currency: "usd",
  status: "pending", provider_charge_id: null, failure_reason: null, idempotency_key: "pay_1", created_at: WHEN,
};
const SUCCEEDED_CHARGE_ROW = Object.assign({}, PENDING_CHARGE_ROW, {
  status: "succeeded", provider_charge_id: "ch_000001",
});
const REFUND_ROW = {
  id: UUID_REFUND, charge_id: UUID_CHARGE, order_id: "10", customer_id: "7",
  amount_cents: "5000", status: "succeeded", provider_refund_id: "re_000002",
  failure_reason: null, idempotency_key: "ref_1", created_at: WHEN,
};

function appFor(svc) {
  const app = express();
  const idem = guardMiddleware(60000, 1000);
  app.use("/api/v1/payments", idem, customerRoutes(svc, tm));
  app.use("/api/v1/admin/refunds", idem, adminRoutes(svc, tm));
  return app;
}

// expectChargeHappy scripts the pool for a fresh successful charge.
function expectChargeHappy(pool, orderID, idemKey) {
  pool.expectSQL(`SELECT ${CHARGE_COLS} FROM charges WHERE idempotency_key = $1`, { args: [idemKey], rows: [] });
  pool.expectSQL(ORDERS_FOR_UPDATE, { args: [orderID], rows: [{ status: "pending", total_cents: "5000", currency: "usd" }] });
  pool.expectSQL(INSERT_CHARGE, { args: [orderID, 7, 5000, "usd", idemKey], rows: [{ id: UUID_CHARGE }] });
  pool.expectSQL(UPDATE_CHARGE_SUCCEEDED, { args: [UUID_CHARGE, "ch_000001"] });
  pool.expectSQL(UPDATE_ORDER_PAID, { args: [orderID], rowCount: 1 });
}

test("payment route literals + guard: charges/refunds under /api/v1/payments + /admin/refunds", async () => {
  const pool = memPool();
  const cache = new MemCache();
  const svc = new Service(pool, cache, NewStubGateway(), 4, 1);
  const srv = await serve(appFor(svc));
  try {
    const auth = { Authorization: "Bearer " + userTok };

    const noAuth = await fetch(srv.base + "/api/v1/payments/charges");
    assert.equal(noAuth.status, 401);
    assert.deepEqual((await noAuth.json()).error, { code: "unauthorized", message: "missing bearer token" });

    pool.expectSQL(MY_CHARGES, { args: [7], rows: [] });
    const myCharges = await fetch(srv.base + "/api/v1/payments/charges", { headers: auth });
    assert.equal(myCharges.status, 200);
    assert.deepEqual(await myCharges.json(), { charges: [] });

    const noKey = await fetch(srv.base + "/api/v1/payments/charges", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, auth),
      body: JSON.stringify({ order_id: 10 }),
    });
    assert.equal(noKey.status, 400);
    assert.deepEqual((await noKey.json()).error, { code: "bad_request", message: "Idempotency-Key header is required" });

    const noOrder = await fetch(srv.base + "/api/v1/payments/charges", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Idempotency-Key": "pay_0" }, auth),
      body: JSON.stringify({ order_id: 0 }),
    });
    assert.equal(noOrder.status, 400);
    assert.deepEqual((await noOrder.json()).error, { code: "bad_request", message: "order_id is required" });

    expectChargeHappy(pool, 10, "pay_1");
    const charge = await fetch(srv.base + "/api/v1/payments/charges", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Idempotency-Key": "pay_1" }, auth),
      body: JSON.stringify({ order_id: 10 }),
    });
    assert.equal(charge.status, 201);
    const chargeBody = await charge.json();
    assert.equal(chargeBody.id, UUID_CHARGE);
    assert.equal(chargeBody.order_id, 10);
    assert.equal(chargeBody.customer_id, 7);
    assert.equal(chargeBody.amount_cents, 5000);
    assert.equal(chargeBody.currency, "usd");
    assert.equal(chargeBody.status, "succeeded");
    assert.equal(chargeBody.provider_charge_id, "ch_000001");
    assert.equal(chargeBody.idempotency_key, "pay_1");
    assert.ok(chargeBody.created_at);

    pool.expectSQL(CHARGES_BY_ID, { args: [UUID_CHARGE], rows: [SUCCEEDED_CHARGE_ROW] });
    const getCharge = await fetch(srv.base + "/api/v1/payments/charges/" + UUID_CHARGE, { headers: auth });
    assert.equal(getCharge.status, 200);
    assert.equal((await getCharge.json()).status, "succeeded");

    pool.expectSQL(CHARGES_BY_ID, { args: [UUID_CHARGE], rows: [SUCCEEDED_CHARGE_ROW] });
    const other = await fetch(srv.base + "/api/v1/payments/charges/" + UUID_CHARGE, { headers: { Authorization: "Bearer " + otherTok } });
    assert.equal(other.status, 403);
    assert.deepEqual((await other.json()).error, { code: "forbidden", message: "not allowed to view this charge" });

    pool.expectSQL(SELECT_CHARGES_BY_ORDER, { args: [10], rows: [SUCCEEDED_CHARGE_ROW] });
    pool.expectSQL(REFUNDED_TOTAL, { args: [UUID_CHARGE], rows: [{ sum: 0 }] });
    pool.expectSQL(SELECT_REFUND_BY_KEY, { args: ["ref_1"], rows: [] });
    pool.expectSQL(INSERT_REFUND, { args: [UUID_CHARGE, 7, 5000, "ref_1"], rows: [{ id: UUID_REFUND }] });
    pool.expectSQL(UPDATE_REFUND_SUCCEEDED, { args: [UUID_REFUND, "re_000002"] });
    pool.expectSQL(UPDATE_CHARGE_REFUNDED, { args: [UUID_CHARGE] });
    const refund = await fetch(srv.base + "/api/v1/payments/refunds", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Idempotency-Key": "ref_1" }, auth),
      body: JSON.stringify({ order_id: 10, amount_cents: 0, reason: "not satisfied" }),
    });
    assert.equal(refund.status, 201);
    const refundBody = await refund.json();
    assert.equal(refundBody.id, UUID_REFUND);
    assert.equal(refundBody.charge_id, UUID_CHARGE);
    assert.equal(refundBody.order_id, 10);
    assert.equal(refundBody.amount_cents, 5000);
    assert.equal(refundBody.status, "succeeded");
    assert.equal(refundBody.provider_refund_id, "re_000002");
    assert.equal(refundBody.idempotency_key, "ref_1");

    pool.expectSQL(MY_REFUNDS, { args: [7], rows: [REFUND_ROW] });
    const myRefunds = await fetch(srv.base + "/api/v1/payments/refunds", { headers: auth });
    assert.equal(myRefunds.status, 200);
    const refundsBody = await myRefunds.json();
    assert.equal(refundsBody.refunds.length, 1);
    assert.equal(refundsBody.refunds[0].id, UUID_REFUND);

    const notAdmin = await fetch(srv.base + "/api/v1/admin/refunds", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Idempotency-Key": "ref_admin" }, auth),
      body: JSON.stringify({ order_id: 10 }),
    });
    assert.equal(notAdmin.status, 403);
    assert.deepEqual((await notAdmin.json()).error, { code: "forbidden", message: "administrator role required" });

    pool.expectSQL(SELECT_CHARGES_BY_ORDER, { args: [10], rows: [SUCCEEDED_CHARGE_ROW] });
    pool.expectSQL(REFUNDED_TOTAL, { args: [UUID_CHARGE], rows: [{ sum: 0 }] });
    pool.expectSQL(SELECT_REFUND_BY_KEY, { args: ["ref_admin2"], rows: [] });
    pool.expectSQL(INSERT_REFUND, { args: [UUID_CHARGE, 1, 5000, "ref_admin2"], rows: [{ id: UUID_REFUND }] });
    pool.expectSQL(UPDATE_REFUND_SUCCEEDED, { args: [UUID_REFUND, "re_000003"] });
    pool.expectSQL(UPDATE_CHARGE_REFUNDED, { args: [UUID_CHARGE] });
    const adminRefund = await fetch(srv.base + "/api/v1/admin/refunds", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json", "Idempotency-Key": "ref_admin2" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ order_id: 10 }),
    });
    assert.equal(adminRefund.status, 201);
    assert.equal((await adminRefund.json()).customer_id, 7);
  } finally {
    await srv.close();
  }
});

test("payment decline -> 422 payment_declined (no retry)", async () => {
  const pool = memPool();
  const cache = new MemCache();
  const svc = new Service(pool, cache, NewStubGateway(), 4, 1);
  pool.expectSQL(`SELECT ${CHARGE_COLS} FROM charges WHERE idempotency_key = $1`, { args: ["pay_x"], rows: [] });
  pool.expectSQL(ORDERS_FOR_UPDATE, { args: [10], rows: [{ status: "pending", total_cents: "5000", currency: "usd" }] });
  pool.expectSQL(INSERT_CHARGE, { args: [10, 7, 5000, "usd", "pay_x"], rows: [{ id: UUID_CHARGE }] });
  pool.expectSQL(UPDATE_CHARGE_FAILED, { args: [UUID_CHARGE, "payment declined: stub: card declined"] });

  await assert.rejects(
    svc.Charge(10, 7, "pay_x", "decline"),
    (err) => err.status === 422 && err.code === "payment_declined" && err.message === "stub: card declined"
  );
});

test("payment transient network -> restart -> settles (ch_000001)", async () => {
  const pool = memPool();
  const cache = new MemCache();
  const svc = new Service(pool, cache, NewStubGateway(), 3, 1);
  const idemKey = "pay_net";
  // attempt 1: fresh claim, provider blips
  pool.expectSQL(`SELECT ${CHARGE_COLS} FROM charges WHERE idempotency_key = $1`, { args: [idemKey], rows: [] });
  pool.expectSQL(ORDERS_FOR_UPDATE, { args: [10], rows: [{ status: "pending", total_cents: "5000", currency: "usd" }] });
  pool.expectSQL(INSERT_CHARGE, { args: [10, 7, 5000, "usd", idemKey], rows: [{ id: UUID_CHARGE }] });
  pool.expectSQL(UPDATE_CHARGE_TRANSIENT, { args: [UUID_CHARGE, "transient payment failure: stub: upstream network timeout"] });
  // attempt 2: resume from pending (no provider ref), provider settles on retry
  pool.expectSQL(`SELECT ${CHARGE_COLS} FROM charges WHERE idempotency_key = $1`, { args: [idemKey], rows: [PENDING_CHARGE_ROW] });
  pool.expectSQL(UPDATE_CHARGE_SUCCEEDED, { args: [UUID_CHARGE, "ch_000001"] });
  pool.expectSQL(UPDATE_ORDER_PAID, { args: [10], rowCount: 1 });

  const charge = await svc.Charge(10, 7, idemKey, "network");
  assert.equal(charge.status, "succeeded");
  assert.equal(charge.provider_charge_id, "ch_000001");
  assert.equal(charge.id, UUID_CHARGE);
});

test("refund: fully refunded charge is a conflict", async () => {
  const pool = memPool();
  const cache = new MemCache();
  const svc = new Service(pool, cache, NewStubGateway(), 4, 1);
  pool.expectSQL(`SELECT ${CHARGE_COLS} FROM charges WHERE order_id = $1`, { args: [10], rows: [SUCCEEDED_CHARGE_ROW] });
  pool.expectSQL(REFUNDED_TOTAL, { args: [UUID_CHARGE], rows: [{ sum: 5000 }] });

  await assert.rejects(
    svc.Refund(10, 7, 0, "ref_x", "", false),
    (err) => err.status === 409 && err.code === "conflict" && err.message === "charge is already fully refunded"
  );
});