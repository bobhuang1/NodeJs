"use strict";
/* payment service — NodeJs port of GoLang internal/payment/service.go VERBATIM
 * (statuses, session keys, SQL, 422 payment_declined, restart-after-transient
 * retry loops with BackoffDelay, markPaid / finaliseRefund transactions). */
const { BadRequest, Conflict, Forbidden, NotFound, Internal, Wrap, APIError } = require("../httpx/respond.js");
const { BackoffDelay } = require("../cache/backoff.js");
const {
  ChargePending, ChargeSucceeded, ChargeFailed,
  RefundSucceeded, NewTransient, IsTransient, PermanentError,
} = require("./gateway.js");

function sessionKey(kind, key) {
  return "payment:session:" + kind + ":" + key;
}

const CHARGE_COLS =
  `id::text, order_id, customer_id, amount_cents, currency, status, provider_charge_id,
   failure_reason, idempotency_key, created_at`;

class Service {
  // wires payment to its dependencies (pool, cache, gateway, maxAttempt, baseDelay).
  constructor(pool, cache, gateway, maxAttempt, baseDelay) {
    this.pool = pool;
    this.cache = cache;
    this.gateway = gateway;
    this.maxAttempt = maxAttempt > 0 ? maxAttempt : 4;
    this.baseDelay = baseDelay > 0 ? baseDelay : 100;
  }

  // Charge takes payment for an order with the restart-after-transient loop.
  async Charge(orderID, customerID, idemKey, simulate) {
    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxAttempt; attempt++) {
      if (attempt > 1) {
        const delay = BackoffDelay(attempt - 1, this.baseDelay);
        console.warn("payment process restarting",
          { order_id: orderID, idem_key: idemKey, attempt: attempt - 1, delay_ms: delay, err: String(lastErr) });
        await sleep(delay);
      }
      try {
        return await this.chargeOnce(orderID, customerID, idemKey, simulate);
      } catch (err) {
        if (IsTransient(err)) { lastErr = err; continue; }
        throw err;
      }
    }
    throw Internal("payment failed after retries", lastErr);
  }

  async chargeOnce(orderID, customerID, idemKey, simulate) {
    // Redis session marker. Its failure restarts the whole payment process.
    const marker = Buffer.from(JSON.stringify({ order_id: orderID, key: idemKey }));
    try {
      await this.cache.set(sessionKey("charge", idemKey), marker, 15 * 60 * 1000);
    } catch (err) {
      throw NewTransient(new Error(`redis caching failed: ${String(err)}`));
    }

    // Replay / claim the charge (see Go comment for the resume semantics).
    let replayed;
    try {
      replayed = await this.findChargeByKey(idemKey);
    } catch (err) {
      throw err;
    }
    if (replayed && (replayed.status !== ChargePending || replayed.provider_charge_id !== "")) {
      return replayed;
    }

    let chargeID = "";
    let amount = 0;
    let currency = "";
    if (replayed !== null && replayed !== undefined) {
      chargeID = replayed.id;
      amount = replayed.amount_cents;
      currency = replayed.currency;
    }
    if (replayed == null) {
      const tx = await this.pool.begin();
      try {
        let row;
        try {
          row = await tx.queryRow(
            `SELECT status, total_cents, currency FROM orders
            WHERE id = $1 FOR UPDATE`,
            [orderID]
          );
        } catch (err) {
          throw Wrap(err);
        }
        if (!row) throw NotFound("order not found");

        const oStatus = row.status;
        amount = Number(row.total_cents);
        currency = row.currency;
        switch (oStatus) {
          case ChargeSucceeded:
          case "refunded":
          case "cancelled":
          case "processing":
          case "shipped":
          case "delivered":
            throw Conflict(`order already has a terminal payment state (${oStatus})`);
          case "pending":
            // ok, proceed
            break;
          default:
            throw Conflict(`order cannot be charged in status ${oStatus}`);
        }

        try {
          const ins = await tx.queryRow(
            `INSERT INTO charges (order_id, customer_id, amount_cents, currency, idempotency_key)
            VALUES ($1,$2,$3,$4,$5)
            RETURNING id::text`,
            [orderID, customerID, amount, currency, idemKey]
          );
          chargeID = ins.id;
        } catch (err) {
          throw Wrap(err);
        }
        await tx.commit();
      } catch (err) {
        try { await tx.rollback(); } catch (e) { /* already rolled back */ }
        throw err;
      }
    } else {
      chargeID = replayed.id;
    }

    // External provider call (out of the DB transaction).
    const meta = {};
    if (simulate !== "") meta.simulate = simulate;
    let res;
    try {
      res = this.gateway.createCharge({
        Amount: amount,
        Currency: currency,
        Description: `order ${orderID}`,
        IdempotencyKey: idemKey,
        Metadata: meta,
      });
    } catch (err) {
      if (IsTransient(err)) {
        await this.markChargeTransient(chargeID, err.message);
        throw NewTransient(err);
      }
      if (err instanceof PermanentError) {
        await this.markChargeFailed(chargeID, err.message);
        throw new APIError(422, "payment_declined", err.reason);
      }
      throw Wrap(err);
    }

    const charge = {
      id: chargeID,
      order_id: orderID,
      customer_id: customerID,
      amount_cents: amount,
      currency,
      status: res.status,
      provider_charge_id: res.id,
      failure_reason: "",
      idempotency_key: idemKey,
      created_at: new Date(),
    };

    if (res.status === ChargePending) {
      // Async settlement: leave the order pending, record the provider ref.
      await this.markChargeProvider(chargeID, res.id, ChargePending);
      return charge;
    }
    if (res.status === ChargeFailed) {
      await this.markChargeFailed(chargeID, "provider reported failure");
      throw paymentDeclined("provider reported failure");
    }

    // Success: finalise charge AND flip the order to paid in one transaction.
    await this.markPaid(chargeID, orderID, res.id);
    charge.status = ChargeSucceeded;
    try {
      await this.cache.del(sessionKey("charge", idemKey));
    } catch (err) { /* best-effort */ }
    return charge;
  }

  // markPaid finalises a successful charge and moves the order to paid
  // atomically. Rolled back entirely if either update fails.
  async markPaid(chargeID, orderID, providerID) {
    const tx = await this.pool.begin();
    try {
      await tx.exec(
        `UPDATE charges SET status = 'succeeded', provider_charge_id = $2, updated_at = now()
        WHERE id = $1::uuid AND status = 'pending'`,
        [chargeID, providerID]
      );
      let tag;
      try {
        tag = await tx.exec(
          `UPDATE orders SET status = 'paid', version = version + 1, updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
          [orderID]
        );
      } catch (err) {
        throw err;
      }
      if (tag.rowCount === 0) throw new Error("order is not pending anymore");
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }
  }

  async markChargeProvider(chargeID, providerID, status) {
    const tx = await this.pool.begin();
    try {
      await tx.exec(
        `UPDATE charges SET status = $2::charge_status, provider_charge_id = $3, updated_at = now()
        WHERE id = $1::uuid`,
        [chargeID, status, providerID]
      );
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }
  }

  async markChargeFailed(chargeID, reason) {
    const tx = await this.pool.begin();
    try {
      await tx.exec(
        `UPDATE charges SET status = 'failed', failure_reason = $2, updated_at = now()
        WHERE id = $1::uuid`,
        [chargeID, reason]
      );
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }
  }

  async markChargeTransient(chargeID, reason) {
    const tx = await this.pool.begin();
    try {
      await tx.exec(
        `UPDATE charges SET failure_reason = $2, updated_at = now()
        WHERE id = $1::uuid AND status = 'pending'`,
        [chargeID, reason]
      );
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }
  }

  // findChargeByKey replays a previously claimed charge, if the key is known.
  async findChargeByKey(idemKey) {
    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT ${CHARGE_COLS}
        FROM charges WHERE idempotency_key = $1`,
        [idemKey]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) return null;
    return mapCharge(row);
  }

  // ChargeByID returns a charge with caller authz (own or admin).
  async ChargeByID(chargeID, customerID, admin) {
    const c = await this.chargeByID(chargeID);
    if (!admin && c.customer_id !== customerID) {
      throw Forbidden("not allowed to view this charge");
    }
    return c;
  }

  async chargeByID(chargeID) {
    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT ${CHARGE_COLS}
        FROM charges WHERE id = $1::uuid`,
        [chargeID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("charge not found");
    return mapCharge(row);
  }

  // MyCharges lists the caller's charges.
  async MyCharges(customerID) {
    let res;
    try {
      res = await this.pool.query(
        `SELECT ${CHARGE_COLS}
        FROM charges WHERE customer_id = $1 ORDER BY created_at DESC`,
        [customerID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    return res.rows.map(mapCharge);
  }

  // MyRefunds lists the caller's refunds (with their order ids).
  async MyRefunds(customerID) {
    let res;
    try {
      res = await this.pool.query(
        `SELECT r.id::text, r.charge_id::text, c.order_id, r.customer_id, r.amount_cents, r.status,
               r.provider_refund_id, r.failure_reason, r.idempotency_key, r.created_at
        FROM refunds r JOIN charges c ON c.id = r.charge_id
        WHERE r.customer_id = $1 ORDER BY r.created_at DESC`,
        [customerID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    return res.rows.map(mapRefund);
  }

  // Refund reverses part or all of a charge. Same idempotency discipline.
  async Refund(orderID, actingCustomer, amountCents, idemKey, reason, admin) {
    const charge = await this.chargeByOrder(orderID);
    if (!admin && charge.customer_id !== actingCustomer) {
      throw Forbidden("not allowed to refund this order");
    }
    if (charge.status === ChargeFailed || charge.status === ChargePending) {
      throw Conflict("charge has no collected funds to refund");
    }
    const refundedSoFar = await this.refundedTotal(charge.id);
    const remaining = charge.amount_cents - refundedSoFar;
    if (remaining <= 0) throw Conflict("charge is already fully refunded");
    // amount_cents is optional: 0 (or omitted) means "refund everything left".
    if (amountCents <= 0) amountCents = remaining;
    if (amountCents > remaining) {
      throw BadRequest(`amount must be between 1 and ${remaining} cents`);
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= this.maxAttempt; attempt++) {
      if (attempt > 1) {
        const delay = BackoffDelay(attempt - 1, this.baseDelay);
        console.warn("refund process restarting",
          { charge_id: charge.id, idem_key: idemKey, attempt: attempt - 1, err: String(lastErr) });
        await sleep(delay);
      }
      try {
        return await this.refundOnce(charge, actingCustomer, amountCents, idemKey, reason);
      } catch (err) {
        if (IsTransient(err)) { lastErr = err; continue; }
        throw err;
      }
    }
    throw Internal("refund failed after retries", lastErr);
  }

  async refundOnce(charge, actingCustomer, amountCents, idemKey, reason) {
    const cached = await this.findRefundByKey(idemKey);
    if (cached !== null && cached !== undefined) return cached;

    let refundID;
    const tx = await this.pool.begin();
    try {
      let ins;
      try {
        ins = await tx.queryRow(
          `INSERT INTO refunds (charge_id, customer_id, amount_cents, idempotency_key)
          VALUES ($1::uuid, $2, $3, $4)
          RETURNING id::text`,
          [charge.id, actingCustomer, amountCents, idemKey]
        );
      } catch (err) {
        throw Wrap(err);
      }
      refundID = ins.id;
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }

    let res;
    try {
      res = this.gateway.refundCharge({
        ChargeID: charge.provider_charge_id,
        Amount: amountCents,
        IdempotencyKey: idemKey,
        Reason: reason,
      });
    } catch (err) {
      if (IsTransient(err)) {
        await this.setRefundTransient(refundID, err.message);
        throw NewTransient(err);
      }
      await this.setRefundFailed(refundID, err.message);
      throw Wrap(err);
    }

    // Finalise: mark refund delivered and roll the charge to 'refunded' when
    // it is now fully refunded. Atomic, rolled back on any failure.
    await this.finaliseRefund(refundID, charge.id, res.id);
    const r = {
      id: refundID,
      charge_id: charge.id,
      order_id: charge.order_id,
      customer_id: charge.customer_id,
      amount_cents: amountCents,
      status: RefundSucceeded,
      provider_refund_id: res.id,
      failure_reason: "",
      idempotency_key: idemKey,
      created_at: new Date(),
    };
    try {
      await this.cache.del(sessionKey("refund", idemKey));
    } catch (err) { /* best-effort */ }
    return r;
  }

  // finaliseRefund commits the successful refund and marks the charge refunded
  // when it is fully covered. Transactional: any failure rolls back both.
  async finaliseRefund(refundID, chargeID, providerRefundID) {
    const tx = await this.pool.begin();
    try {
      await tx.exec(
        `UPDATE refunds SET status = 'succeeded', provider_refund_id = $2, updated_at = now()
        WHERE id = $1::uuid`,
        [refundID, providerRefundID]
      );
      await tx.exec(
        `UPDATE charges SET
          status = CASE WHEN (
            COALESCE((SELECT SUM(amount_cents) FILTER (WHERE status = 'succeeded') FROM refunds WHERE charge_id = $1::uuid), 0)
            >= amount_cents
          ) THEN 'refunded' ELSE status END,
          updated_at = now()
        WHERE id = $1::uuid`,
        [chargeID]
      );
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }
  }

  async setRefundTransient(refundID, reason) {
    const tx = await this.pool.begin();
    try {
      await tx.exec(
        `UPDATE refunds SET failure_reason = $2, updated_at = now()
        WHERE id = $1::uuid AND status = 'pending'`,
        [refundID, reason]
      );
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }
  }

  async setRefundFailed(refundID, reason) {
    const tx = await this.pool.begin();
    try {
      await tx.exec(
        `UPDATE refunds SET status = 'failed', failure_reason = $2, updated_at = now()
        WHERE id = $1::uuid`,
        [refundID, reason]
      );
      await tx.commit();
    } catch (err) {
      try { await tx.rollback(); } catch (e) { /* already rolled back */ }
      throw err;
    }
  }

  async chargeByOrder(orderID) {
    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT ${CHARGE_COLS}
        FROM charges WHERE order_id = $1`,
        [orderID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("no charge found for this order");
    return mapCharge(row);
  }

  async refundedTotal(chargeID) {
    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE status = 'succeeded'), 0)
        FROM refunds WHERE charge_id = $1::uuid`,
        [chargeID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) return 0;
    return Number(Object.values(row)[0] || 0);
  }

  async findRefundByKey(idemKey) {
    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT r.id::text, r.charge_id::text, c.order_id, r.customer_id, r.amount_cents, r.status,
               r.provider_refund_id, r.failure_reason, r.idempotency_key, r.created_at
        FROM refunds r JOIN charges c ON c.id = r.charge_id
        WHERE r.idempotency_key = $1`,
        [idemKey]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) return null;
    return mapRefund(row);
  }
}

function paymentDeclined(message) {
  return new APIError(422, "payment_declined", message);
}

function mapCharge(r) {
  return {
    id: r.id,
    order_id: Number(r.order_id),
    customer_id: Number(r.customer_id),
    amount_cents: Number(r.amount_cents),
    currency: r.currency,
    status: r.status,
    provider_charge_id: r.provider_charge_id || "",
    failure_reason: r.failure_reason || "",
    idempotency_key: r.idempotency_key,
    created_at: r.created_at,
  };
}

function mapRefund(r) {
  return {
    id: r.id,
    charge_id: r.charge_id,
    order_id: Number(r.order_id),
    customer_id: Number(r.customer_id),
    amount_cents: Number(r.amount_cents),
    status: r.status,
    provider_refund_id: r.provider_refund_id || "",
    failure_reason: r.failure_reason || "",
    idempotency_key: r.idempotency_key,
    created_at: r.created_at,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Service, sessionKey, mapCharge, mapRefund, CHARGE_COLS };