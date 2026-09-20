"use strict";
/* cart domain — NodeJs port of GoLang internal/cart/cart.go (Service) VERBATIM:
 * SQL text, validation messages, JSON shapes, and the single-transaction
 * checkout (FOR UPDATE stock reservation -> order create -> clear cart -> commit,
 * idempotency-key replay on 23505). product/order flows through injected seams
 * to avoid load order coupling; wired defaults pull the real modules.
 *   product: { get(id), reserveStock(tx, productId, qty) }   src/product
 *   order:   { Create(tx, customerId, totalCents, currency, idemKey),
 *              AddItem(tx, orderId, productId, name, unitCents, qty) }  src/order */
const { BadRequest, NotFound, Wrap } = require("../httpx/respond.js");

class Service {
  constructor(pool, product, orderSeam) {
    if (!pool) throw new Error("cart.Service requires a pool");
    this.pool = pool;
    this.product = product; // required: product.Service instance (src/product)
    this.order = orderSeam || require("../order/order.service.js");
  }

  // View returns the customer's cart, enriching product lines concurrently.
  // Go resolves every line through the product store via errgroup; each line
  // whose product vanished is silently skipped.
  async view(customerID) {
    const res = await this.pool.query(
      `SELECT product_id, qty FROM cart_items
      WHERE customer_id = $1 ORDER BY product_id`,
      [customerID]
    );
    const items = res.rows;

    const products = new Map();
    await Promise.all(
      items.map(async (it) => {
        const p = await this.product.get(it.product_id);
        products.set(p.id, p);
      })
    );

    const out = { items: [], total_cents: 0, currency: "", count: 0 };
    for (const it of items) {
      const p = products.get(it.product_id);
      if (!p) continue; // product vanished; cart line silently skipped
      const lineTotal = p.price_cents * it.qty;
      out.items.push({
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        unit_price_cents: p.price_cents,
        currency: p.currency,
        qty: it.qty,
      });
      out.total_cents += lineTotal;
      out.count += it.qty;
      out.currency = p.currency;
    }
    return out;
  }

  // Add inserts or updates a line (absolute quantity merge).
  async add(customerID, productID, qty) {
    if (qty < 1) throw BadRequest("quantity must be >= 1");
    await this.product.get(productID); // 404/conflict propagate
    await this.pool.exec(
      `INSERT INTO cart_items (customer_id, product_id, qty)
      VALUES ($1,$2,$3)
      ON CONFLICT (customer_id, product_id)
      DO UPDATE SET qty = excluded.qty, updated_at = now()`,
      [customerID, productID, qty]
    );
  }

  // Update sets the quantity of a line (0 or negative deletes it).
  async update(customerID, productID, qty) {
    const tag = await this.pool.exec(
      `UPDATE cart_items SET qty = $3, updated_at = now()
      WHERE customer_id = $1 AND product_id = $2`,
      [customerID, productID, qty]
    );
    if (tag.rowCount === 0) throw NotFound("product not in cart");
  }

  // Remove deletes a line.
  async remove(customerID, productID) {
    await this.pool.exec(
      `DELETE FROM cart_items WHERE customer_id = $1 AND product_id = $2`,
      [customerID, productID]
    );
  }

  // Clear empties the cart.
  async clear(customerID) {
    await this.pool.exec(
      `DELETE FROM cart_items WHERE customer_id = $1`,
      [customerID]
    );
  }

  // Checkout turns the cart into an order inside one transaction. Stock is
  // reserved line-by-line with FOR UPDATE; any failure rolls everything back.
  // The order's idempotency_key makes the whole operation replay-safe.
  async checkout(customerID, idemKey) {
    if (idemKey === undefined || idemKey === "") {
      throw BadRequest("Idempotency-Key header is required for checkout");
    }

    const tx = await this.pool.begin();
    try {
      const rows = (
        await tx.query(
          `SELECT product_id, qty FROM cart_items
          WHERE customer_id = $1 ORDER BY product_id`,
          [customerID]
        )
      ).rows;
      if (rows.length === 0) throw BadRequest("cart is empty");

      // Reserve stock and compute the total, all inside the transaction.
      let currency = "usd";
      let total = 0;
      const reserved = [];
      for (const it of rows) {
        const p = await this.product.reserveStock(tx, it.product_id, it.qty);
        total += p.price_cents * it.qty;
        currency = p.currency;
        reserved.push({
          product_id: p.id,
          product_name: p.name,
          unit_price_cents: p.price_cents,
          qty: it.qty,
        });
      }

      let o;
      try {
        o = await this.order.Create(tx, customerID, total, currency, idemKey);
      } catch (err) {
        if (err && err.code === "23505") {
          // Same idempotency key: replay the already-created order.
          return await this.replayOrder(idemKey);
        }
        throw Wrap(err);
      }

      for (const it of reserved) {
        await this.order.AddItem(tx, o.id, it.product_id, it.product_name, it.unit_price_cents, it.qty);
      }
      await tx.exec(`DELETE FROM cart_items WHERE customer_id = $1`, [customerID]);
      await tx.commit();

      return Object.assign({}, o, { items: reserved });
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  }

  // replayOrder returns the already-created order for a repeated checkout key.
  async replayOrder(idemKey) {
    const row = await this.pool.queryRow(
      `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
      FROM orders WHERE idempotency_key = $1`,
      [idemKey]
    );
    if (!row) throw NotFound("order for this key was rolled back");
    const items = await this.linesForOrder(row.id);
    return { ...mapOrder(row), items };
  }

  async linesForOrder(orderID) {
    const res = await this.pool.query(
      `SELECT product_id, product_name, unit_price_cents, qty
      FROM order_items WHERE order_id = $1 ORDER BY product_id`,
      [orderID]
    );
    return res.rows.map(mapItem);
  }
}

function mapOrder(r) {
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
}

function mapItem(r) {
  return {
    product_id: Number(r.product_id),
    product_name: r.product_name,
    unit_price_cents: Number(r.unit_price_cents),
    qty: Number(r.qty),
  };
}

module.exports = { Service, mapOrder, mapItem };