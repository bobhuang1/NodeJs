"use strict";
/* product handler + service test — route literals (GoLang internal/product/
 * handlers.go) and the read-through cache service (product.go). Cache = Null
 * seam (always miss) so every read resolves through the scripted pool. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { serve } = require("../../test/http.js");
const { memPool } = require("../../test/db/pgmem.js");
const { publicRoutes, adminRoutes } = require("../../src/product/product.handlers.js");
const { Service } = require("../../src/product/product.service.js");
const { TokenManager } = require("../../src/auth/token.js");
const { Null } = require("../../src/cache/redis.js");

const tm = new TokenManager("product-test-secret", 60, 5);
const adminTok = tm.sign(1, "admin@example.com", "admin");
const customerTok = tm.sign(2, "cust@example.com", "customer");

const LIST_SQL =
  `SELECT id, sku, name, description, price_cents, currency, stock, active, created_at
        FROM products
        WHERE active = TRUE AND ($3 = '' OR name ILIKE $3 OR sku ILIKE $3 OR description ILIKE $3)
        ORDER BY id
        LIMIT $1 OFFSET $2`;
const GET_SQL =
  `SELECT id, sku, name, description, price_cents, currency, stock, active, created_at
        FROM products WHERE id = $1 AND active = TRUE`;
const CREATE_SQL =
  `INSERT INTO products (sku, name, description, price_cents, currency, stock)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, sku, name, description, price_cents, currency, stock, active, created_at`;
const UPDATE_SQL =
  `UPDATE products SET
            sku            = COALESCE(NULLIF($2, ''), sku),
            name           = COALESCE(NULLIF($3, ''), name),
            description    = COALESCE($4, description),
            price_cents    = COALESCE($5, price_cents),
            currency       = COALESCE(NULLIF($6, ''), currency),
            stock          = COALESCE($7, stock),
            updated_at     = now()
        WHERE id = $1`;
const DEACTIVATE_SQL =
  `UPDATE products SET active = FALSE, updated_at = now() WHERE id = $1`;

const WHEN = new Date("2026-09-19T00:00:00Z");
const ROW = {
  id: "1", sku: "SK1", name: "Widget", description: "A widget",
  price_cents: "1000", currency: "usd", stock: 10, active: true, created_at: WHEN,
};
const PRODUCT = {
  id: 1, sku: "SK1", name: "Widget", description: "A widget",
  price_cents: 1000, currency: "usd", stock: 10, active: true, created_at: WHEN.toJSON(),
};

function appFor(svc) {
  const app = express();
  app.use("/api/v1/products", publicRoutes(svc));
  app.use("/api/v1/admin/products", adminRoutes(svc, tm));
  return app;
}

test("admin product route literals: create/update/delete + admin guard", async () => {
  const pool = memPool();
  const svc = new Service(pool, Null);
  const srv = await serve(appFor(svc));
  try {
    const noAuth = await fetch(srv.base + "/api/v1/admin/products", { method: "POST" });
    assert.equal(noAuth.status, 401);

    const forbidden = await fetch(srv.base + "/api/v1/admin/products", {
      method: "POST",
      headers: { Authorization: "Bearer " + customerTok },
    });
    assert.equal(forbidden.status, 403);
    assert.deepEqual((await forbidden.json()).error, { code: "forbidden", message: "administrator role required" });

    pool.expectSQL(CREATE_SQL, {
      args: ["SK1", "Widget", "A widget", 1000, "usd", 10],
      rows: [ROW],
    });
    const created = await fetch(srv.base + "/api/v1/admin/products", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ sku: "SK1", name: "Widget", description: "A widget", price_cents: 1000, currency: "usd", stock: 10 }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), PRODUCT);

    pool.expectSQL(UPDATE_SQL, {
      args: [3, "SK1", "Widget2", "desc", 1200, "usd", 8],
      rowCount: 1,
    });
    pool.expectSQL(GET_SQL, { args: [3], rows: [Object.assign({}, ROW, { id: "3", name: "Widget2" })] });
    const updated = await fetch(srv.base + "/api/v1/admin/products/3", {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, { Authorization: "Bearer " + adminTok }),
      body: JSON.stringify({ sku: "SK1", name: "Widget2", description: "desc", price_cents: 1200, currency: "usd", stock: 8 }),
    });
    assert.equal(updated.status, 200);

    pool.expectSQL(DEACTIVATE_SQL, { args: [3], rowCount: 1 });
    const removed = await fetch(srv.base + "/api/v1/admin/products/3", {
      method: "DELETE",
      headers: { Authorization: "Bearer " + adminTok },
    });
    assert.equal(removed.status, 204);
  } finally {
    await srv.close();
  }
});

test("public product route literals: list + get (cache miss -> DB)", async () => {
  const pool = memPool();
  const svc = new Service(pool, Null);
  const srv = await serve(appFor(svc));
  try {
    pool.expectSQL(LIST_SQL, { args: [20, 0, ""], rows: [ROW] });
    const list = await fetch(srv.base + "/api/v1/products");
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), { products: [PRODUCT] });

    pool.expectSQL(GET_SQL, { args: [5], rows: [ROW] });
    const get = await fetch(srv.base + "/api/v1/products/5");
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), PRODUCT);

    // missing product -> 404 envelope
    pool.expectSQL(GET_SQL, { args: [99], rows: [] });
    const missing = await fetch(srv.base + "/api/v1/products/99");
    assert.equal(missing.status, 404);
    assert.deepEqual((await missing.json()).error, { code: "not_found", message: "product not found" });
  } finally {
    await srv.close();
  }
});