"use strict";
/* order domain — NodeJs port of GoLang internal/order/order.go VERBATIM (SQL
 * text, status enum, state machine, FOR UPDATE + optimistic version bump).
 * Create/AddItem are package functions used inside the cart checkout tx. */
const { BadRequest, Conflict, NotFound, Wrap } = require("../httpx/respond.js");

const OrderStatus = Object.freeze({
  Pending: "pending",
  Paid: "paid",
  Processing: "processing",
  Shipped: "shipped",
  Delivered: "delivered",
  Cancelled: "cancelled",
});

// Valid reports whether s is a known status.
function StatusValid(s) {
  if (s === undefined || s === null || s === "") return false;
  return Object.values(OrderStatus).includes(s);
}

const ActionConfirm = "confirm";
const ActionCancel = "cancel";

// Create inserts a new order (used by the cart checkout) inside the caller's
// transaction and returns the created order row.
async function Create(tx, customerID, totalCents, currency, idemKey) {
  let row;
  try {
    row = await tx.queryRow(
      `INSERT INTO orders (customer_id, total_cents, currency, idempotency_key)
      VALUES ($1,$2,$3,$4)
      RETURNING id, customer_id, status, total_cents, currency, version, created_at, updated_at`,
      [customerID, totalCents, currency, nullableString(idemKey)]
    );
  } catch (err) {
    throw err;
  }
  return mapOrder(row);
}

// AddItem inserts an order line inside the caller's transaction.
async function AddItem(tx, orderID, productID, productName, unitPriceCents, qty) {
  await tx.exec(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price_cents, qty)
    VALUES ($1,$2,$3,$4,$5)`,
    [orderID, productID, productName, unitPriceCents, qty]
  );
}

class Service {
  constructor(pool) {
    this.pool = pool;
  }

  // FindOrderByIDKey returns an order matching an idempotency key, if any.
  async FindOrderByIDKey(idemKey) {
    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders WHERE idempotency_key = $1`,
        [idemKey]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("order not found");
    return mapOrder(row);
  }

  // ByID loads an order.
  async ByID(orderID) {
    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders WHERE id = $1`,
        [orderID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("order not found");
    return mapOrder(row);
  }

  // Items loads the lines of an order.
  async Items(orderID) {
    let res;
    try {
      res = await this.pool.query(
        `SELECT product_id, product_name, unit_price_cents, qty
        FROM order_items WHERE order_id = $1 ORDER BY product_id`,
        [orderID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    return res.rows.map((r) => ({
      product_id: Number(r.product_id),
      product_name: r.product_name,
      unit_price_cents: Number(r.unit_price_cents),
      qty: Number(r.qty),
    }));
  }

  // View1 returns a full order view (order + lines).
  async View1(orderID) {
    const o = await this.ByID(orderID);
    const items = await this.Items(orderID);
    return { order: o, items };
  }

  // Own lists the orders of the calling customer (order + lines each).
  async Own(customerID) {
    let res;
    try {
      res = await this.pool.query(
        `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders WHERE customer_id = $1 ORDER BY id DESC`,
        [customerID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    const views = [];
    for (const r of res.rows) {
      const items = await this.Items(Number(r.id));
      views.push(Object.assign(mapOrder(r), { items }));
    }
    return views;
  }

  // List returns orders for the admin console, optionally filtered by status.
  async List(status, page, limit) {
    if (page < 1) page = 1;
    if (limit < 1 || limit > 100) limit = 20;
    const offset = (page - 1) * limit;
    const statusFilter = StatusValid(status) ? status : "";
    let res;
    try {
      res = await this.pool.query(
        `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
        FROM orders
        WHERE $3 = '' OR status = $3::order_status
        ORDER BY id DESC
        LIMIT $1 OFFSET $2`,
        [limit, offset, statusFilter]
      );
    } catch (err) {
      throw Wrap(err);
    }
    return res.rows.map((r) => Object.assign(mapOrder(r), { items: null }));
  }

  // Process applies an admin action to an order, guarded inside a transaction.
  // Two concurrent requests race on the FOR UPDATE row lock: the second will see
  // the new status and be rejected if the transition is no longer legal.
  async Process(orderID, action) {
    if (action !== ActionConfirm && action !== ActionCancel) {
      throw BadRequest("unknown action; allowed: confirm, cancel");
    }
    const tx = await this.pool.begin();
    try {
      let row;
      try {
        row = await tx.queryRow(
          `SELECT id, customer_id, status, total_cents, currency, version, created_at, updated_at
          FROM orders WHERE id = $1 FOR UPDATE`,
          [orderID]
        );
      } catch (err) {
        throw Wrap(err);
      }
      if (!row) throw NotFound("order not found");

      const o = mapOrder(row);
      const next = transition(o.status, action);
      if (next === null) {
        throw Conflict(`cannot ${action} an order in status ${o.status}`);
      }

      await tx.exec(
        `UPDATE orders SET status = $2, version = version + 1, updated_at = now()
        WHERE id = $1 AND version = $3`,
        [orderID, next, o.version]
      );
      o.status = next;
      o.version += 1;
      await tx.commit();
      return Object.assign(o, { items: null });
    } catch (err) {
      try {
        await tx.rollback();
      } catch (e) { /* already rolled back */ }
      throw err;
    }
  }
}

// transition defines the legal (status, action) -> next status edges; null when
// the transition is not allowed.
function transition(from, action) {
  if (action === ActionConfirm) {
    if (from === OrderStatus.Paid) return OrderStatus.Processing;
    return null;
  }
  if (action === ActionCancel) {
    if (from === OrderStatus.Pending || from === OrderStatus.Paid || from === OrderStatus.Processing) {
      return OrderStatus.Cancelled;
    }
    return null;
  }
  return null;
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

function nullableString(s) {
  if (s === undefined || s === "") return null;
  return s;
}

module.exports = { Service, Create, AddItem, transition, StatusValid, OrderStatus, ActionConfirm, ActionCancel, mapOrder };