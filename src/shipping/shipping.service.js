"use strict";
/* shipment service — NodeJs port of GoLang internal/shipping/shipping.go VERBATIM.
 * Shipment creation, status advance (pending->picked->in_transit->delivered) and
 * tracking. Every write is serialised by a FOR UPDATE order lock. */
const { BadRequest, Conflict, NotFound, Wrap } = require("../httpx/respond.js");

// Status mirrors the DB shipment_status enum.
const StatusPending = "pending";
const StatusPicked = "picked";
const StatusInTransit = "in_transit";
const StatusDelivered = "delivered";

function statusValid(s) {
  switch (s) {
    case StatusPending:
    case StatusPicked:
    case StatusInTransit:
    case StatusDelivered:
      return true;
  }
  return false;
}

const SHIPMENT_COLS =
  "id::text, order_id, tracking_code, courier, status, created_at, updated_at";

// Service implements the shipping rules.
function Service(pool) {
  this.pool = pool;
}

// Ship creates a shipment for an order and moves the order to 'shipped'.
// The order must be 'processing' or 'paid' (i.e. payment settled). Both the
// shipment insert and the order transition share one transaction.
Service.prototype.Ship = async function ship(orderID, courier, trackingCode) {
  if (courier === "" || trackingCode === "") {
    throw BadRequest("courier and tracking_code are required");
  }
  const tx = await this.pool.begin();
  try {
    let row;
    try {
      row = await tx.queryRow(
        `SELECT status, version FROM orders WHERE id = $1 FOR UPDATE`,
        [orderID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("order not found");

    const oStatus = row.status;
    const oVersion = Number(row.version);
    if (oStatus !== "processing" && oStatus !== "paid") {
      throw Conflict("order must be paid or processing before shipping");
    }

    let sh;
    try {
      sh = await tx.queryRow(
        `INSERT INTO shipments (order_id, tracking_code, courier, status)
        VALUES ($1,$2,$3,'pending')
        RETURNING ${SHIPMENT_COLS}`,
        [orderID, trackingCode, courier]
      );
    } catch (err) {
      throw Wrap(err);
    }
    try {
      await tx.exec(
        `UPDATE orders SET status = 'shipped', version = version + 1, updated_at = now()
        WHERE id = $1 AND status = $2 AND version = $3`,
        [orderID, oStatus, oVersion]
      );
    } catch (err) {
      throw Wrap(err);
    }
    await tx.commit();
    return mapShipment(sh);
  } catch (err) {
    try { await tx.rollback(); } catch (e) { /* already rolled back */ }
    throw err;
  }
};

// Update changes a shipment's status (and optionally the tracking code). When
// the shipment is delivered the order moves to 'delivered' as well.
Service.prototype.Update = async function update(shipmentID, trackingCode, status) {
  if (!statusValid(status)) {
    throw BadRequest("unknown shipment status");
  }
  const tx = await this.pool.begin();
  try {
    let row;
    try {
      row = await tx.queryRow(
        `SELECT ${SHIPMENT_COLS}
        FROM shipments WHERE id = $1::uuid FOR UPDATE`,
        [shipmentID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("shipment not found");

    const sh = mapShipment(row);
    const next = status;
    if (!transitionAllowed(sh.status, next)) {
      throw Conflict("invalid shipment status transition");
    }
    if (trackingCode !== "") {
      sh.tracking_code = trackingCode;
    }
    try {
      await tx.exec(
        `UPDATE shipments SET status = $2::shipment_status, tracking_code = $3,
               updated_at = now()
        WHERE id = $1::uuid`,
        [shipmentID, next, sh.tracking_code]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (next === StatusDelivered) {
      try {
        await tx.exec(
          `UPDATE orders SET status = 'delivered', version = version + 1, updated_at = now()
          WHERE id = $1 AND status = 'shipped'`,
          [sh.order_id]
        );
      } catch (err) {
        throw Wrap(err);
      }
    }
    await tx.commit();
    sh.status = next;
    return sh;
  } catch (err) {
    try { await tx.rollback(); } catch (e) { /* already rolled back */ }
    throw err;
  }
};

// ByOrder returns the shipment for an order (with caller authz in the handler
// via the owning customer).
Service.prototype.ByOrder = async function byOrder(orderID) {
  let row;
  try {
    row = await this.pool.queryRow(
      `SELECT ${SHIPMENT_COLS}
      FROM shipments WHERE order_id = $1`,
      [orderID]
    );
  } catch (err) {
    throw Wrap(err);
  }
  if (!row) throw NotFound("no shipment for this order");
  return mapShipment(row);
};

// Own lists the caller's shipments.
Service.prototype.Own = async function own(customerID) {
  let res;
  try {
    res = await this.pool.query(
      `SELECT s.${SHIPMENT_COLS}
      FROM shipments s JOIN orders o ON o.id = s.order_id
      WHERE o.customer_id = $1 ORDER BY s.created_at DESC`,
      [customerID]
    );
  } catch (err) {
    throw Wrap(err);
  }
  return res.rows.map(mapShipment);
};

// Track looks up a shipment by its public tracking code.
Service.prototype.Track = async function track(code) {
  let row;
  try {
    row = await this.pool.queryRow(
      `SELECT ${SHIPMENT_COLS}
      FROM shipments WHERE tracking_code = $1`,
      [code]
    );
  } catch (err) {
    throw Wrap(err);
  }
  if (!row) throw NotFound("tracking code not found");
  return mapShipment(row);
};

// transitionAllowed guards the shipment state machine.
function transitionAllowed(from, to) {
  if (from === to) return true;
  switch (from) {
    case StatusPending:
      return to === StatusPicked || to === StatusInTransit;
    case StatusPicked:
      return to === StatusInTransit;
    case StatusInTransit:
      return to === StatusDelivered;
    case StatusDelivered:
      return false;
  }
  return false;
}

function mapShipment(r) {
  return {
    id: r.id,
    order_id: Number(r.order_id),
    tracking_code: r.tracking_code,
    courier: r.courier,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

module.exports = {
  Service, StatusPending, StatusPicked, StatusInTransit, StatusDelivered,
  statusValid, transitionAllowed, SHIPMENT_COLS, mapShipment,
};