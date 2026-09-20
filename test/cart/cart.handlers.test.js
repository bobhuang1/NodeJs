"use strict";
/* cart handler + service test — route literals (GoLang internal/cart/handlers.go)
 * and the transactional checkout (cart.go). Real pool surfacing is swapped for
 * the scripted test/db/pgmem.js seam; product/order flows via injected seams. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { serve } = require("../../test/http.js");
const { memPool } = require("../../test/db/pgmem.js");
const { routes } = require("../../src/cart/cart.handlers.js");
const { Service } = require("../../src/cart/cart.service.js");
const { TokenManager } = require("../../src/auth/token.js");

const tm = new TokenManager("cart-test-secret", 60, 5);
const tok = tm.sign(1, "cart@example.com", "customer");
const AUTH = { Authorization: "Bearer " + tok };

const CART_SELECT =
  `SELECT product_id, qty FROM cart_items
      WHERE customer_id = $1 ORDER BY product_id`;
const RESERVE_SELECT =
  `SELECT id, sku, name, price_cents, currency, stock, active
      FROM products WHERE id = $1 FOR UPDATE`;
const RESERVE_UPDATE =
  `UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1`;
const ORDER_CREATE =
  `INSERT INTO orders (customer_id, total_cents, currency, idempotency_key)
      VALUES ($1,$2,$3,$4)
      RETURNING id, customer_id, status, total_cents, currency, version, created_at, updated_at`;
const ORDER_ITEM =
  `INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, qty)
      VALUES ($1,$2,$3,$4,$5)`;
const CART_CLEAR = `DELETE FROM cart_items WHERE customer_id = $1`;

function stubSvc() {
  const calls = { view: 0, clear: 0, add: null, update: null, remove: null, checkout: null };
  const svc = {
    calls,
    view: async () => ({ items: [], total_cents: 0, currency: "", count: 0 }),
    clear: async () => { calls.clear++; },
    add: async (c, p, q) => { calls.add = { c, p, q }; },
    update: async (c, p, q) => { calls.update = { c, p, q }; },
    remove: async (c, p) => { calls.remove = { c, p }; },
    checkout: async (c, k) => { calls.checkout = { c, k }; return { id: 1, items: [] }; },
  };
  return svc;
}

function appFor(svc) {
  const app = express();
  app.use("/api/v1/cart", routes(svc, tm));
  return app;
}

test("cart routes require auth; missing bearer -> 401 envelope", async () => {
  const srv = await serve(appFor(stubSvc()));
  try {
    const res = await fetch(srv.base + "/api/v1/cart");
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), {
      error: { code: "unauthorized", message: "missing bearer token" },
    });
  } finally {
    await srv.close();
  }
});

test("cart route literals hit the service handlers (view/clear/add/update/remove/checkout)", async () => {
  const svc = stubSvc();
  const srv = await serve(appFor(svc));
  try {
    const view = await fetch(srv.base + "/api/v1/cart", { headers: AUTH });
    assert.equal(view.status, 200);
    assert.deepEqual(await view.json(), { items: [], total_cents: 0, currency: "", count: 0 });

    const clear = await fetch(srv.base + "/api/v1/cart", { method: "DELETE", headers: AUTH });
    assert.equal(clear.status, 204);
    assert.equal(svc.calls.clear, 1);

    const add = await fetch(srv.base + "/api/v1/cart/items", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, AUTH),
      body: JSON.stringify({ product_id: 5, qty: 2 }),
    });
    assert.equal(add.status, 201);
    assert.deepEqual(await add.json(), { product_id: 5, qty: 2 });
    assert.deepEqual(svc.calls.add, { c: 1, p: 5, q: 2 });

    const upd = await fetch(srv.base + "/api/v1/cart/items/7", {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, AUTH),
      body: JSON.stringify({ qty: 3 }),
    });
    assert.equal(upd.status, 204);
    assert.deepEqual(svc.calls.update, { c: 1, p: 7, q: 3 });

    const del = await fetch(srv.base + "/api/v1/cart/items/7", { method: "DELETE", headers: AUTH });
    assert.equal(del.status, 204);
    assert.deepEqual(svc.calls.remove, { c: 1, p: 7 });

    const co = await fetch(srv.base + "/api/v1/cart/checkout", {
      method: "POST",
      headers: Object.assign({ "Idempotency-Key": "k1" }, AUTH),
    });
    assert.equal(co.status, 201);
    assert.deepEqual(await co.json(), { id: 1, items: [] });
    assert.deepEqual(svc.calls.checkout, { c: 1, k: "k1" });
  } finally {
    await srv.close();
  }
});

function productSeam() {
  return {
    get: async () => {
      throw new Error("product.get should not be called on this path");
    },
    reserveStock: async (tx, productId, qty) => {
      const p = await tx.queryRow(RESERVE_SELECT, [productId]);
      if (!p) throw Object.assign(new Error("not found"), {});
      await tx.exec(RESERVE_UPDATE, [productId, qty]);
      return {
        id: Number(p.id),
        sku: p.sku,
        name: p.name,
        price_cents: Number(p.price_cents),
        currency: p.currency,
        stock: Number(p.stock) - qty,
        active: p.active,
      };
    },
  };
}

function orderSeam() {
  return {
    Create: async (tx, customerId, totalCents, currency, idemKey) => {
      const r = await tx.queryRow(ORDER_CREATE, [customerId, totalCents, currency, idemKey]);
      return {
        id: Number(r.id),
        customer_id: Number(r.customer_id),
        status: r.status,
        total_cents: Number(r.total_cents),
        currency: r.currency,
        version: Number(r.version),
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    },
    AddItem: async (tx, orderId, productId, productName, unitPriceCents, qty) => {
      await tx.exec(ORDER_ITEM, [orderId, productId, productName, unitPriceCents, qty]);
    },
  };
}

const WHEN = new Date("2026-09-19T00:00:00Z");

test("checkout: reserve stock + create order + add items + clear cart (one tx)", async () => {
  const pool = memPool();
  pool.expectSQL(CART_SELECT, { rows: [{ product_id: 1, qty: 2 }] });
  pool.expectSQL(RESERVE_SELECT, {
    rows: [{ id: "1", sku: "S1", name: "Widget", price_cents: "1000", currency: "usd", stock: 5, active: true }],
  });
  pool.expectSQL(RESERVE_UPDATE, { rowCount: 1 });
  pool.expectSQL(ORDER_CREATE, {
    rows: [{
      id: "10", customer_id: "1", status: "pending", total_cents: "2000", currency: "usd",
      version: "1", created_at: WHEN, updated_at: WHEN,
    }],
  });
  pool.expectSQL(ORDER_ITEM, { rowCount: 1 });
  pool.expectSQL(CART_CLEAR, { rowCount: 1 });

  const svc = new Service(pool, productSeam(), orderSeam());
  const out = await svc.checkout(1, "checkout-k1");
  assert.equal(out.id, 10);
  assert.equal(out.customer_id, 1);
  assert.equal(out.status, "pending");
  assert.equal(out.total_cents, 2000);
  assert.equal(out.currency, "usd");
  assert.equal(out.version, 1);
  assert.deepEqual(out.items, [
    { product_id: 1, product_name: "Widget", unit_price_cents: 1000, qty: 2 },
  ]);
});

test("checkout without Idempotency-Key is rejected", async () => {
  const svc = new Service(memPool(), productSeam(), orderSeam());
  await assert.rejects(() => svc.checkout(1, ""), /Idempotency-Key header is required/);
});