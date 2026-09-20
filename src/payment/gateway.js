"use strict";
/* payment gateway — NodeJs port of GoLang internal/payment/gateway.go VERBATIM.
 * Stripe-shaped interface with a deterministic in-memory stub: idempotent at the
 * provider level (byIdemKey), simulate=network (first call transient, retry
 * settles), simulate=decline (permanent), simulate=hold (pending settlement). */
const ChargePending = "pending";
const ChargeSucceeded = "succeeded";
const ChargeFailed = "failed";
const ChargeRefunded = "refunded";

const RefundPending = "pending";
const RefundSucceeded = "succeeded";
const RefundFailed = "failed";

// Simulation modes understood by the stub gateway.
const SimulateNetwork = "network";
const SimulateDecline = "decline";
const SimulateHold = "hold";

// TransientError reports a gateway/cache failure that a restart may fix.
class TransientError extends Error {
  constructor(cause) {
    const msg = cause && cause.message ? cause.message : String(cause);
    super("transient payment failure: " + msg);
    this.transient = true;
    this.cause = cause;
  }
}

// PermanentError reports a definitive card/business rejection (decline).
class PermanentError extends Error {
  constructor(reason) {
    super("payment declined: " + reason);
    this.reason = reason;
  }
}

// NewTransient wraps an error as transient.
function NewTransient(err) {
  return err instanceof TransientError ? err : new TransientError(err);
}

// IsTransient reports whether err is a transient failure.
function IsTransient(err) {
  return !!(err && (err.transient === true || /^transient payment failure:/.test(err.message || "")));
}

// StubGateway is the deterministic stripe-shaped stub provider.
class StubGateway {
  constructor() {
    this.charges = new Map();       // provider id -> ChargeResult
    this.refunds = new Map();       // provider id -> RefundResult
    this.byIdemKey = new Map();     // idempotency key -> provider charge id
    this.refundByKey = new Map();   // idempotency key -> provider refund id
    this.netFirst = new Set();      // keys that already "failed" once
    this.nextID = 0;
  }

  // createCharge mirrors CreateCharge; idempotent at the provider level.
  createCharge(params) {
    if (this.byIdemKey.has(params.IdempotencyKey)) {
      const providerID = this.byIdemKey.get(params.IdempotencyKey);
      return this.charges.get(providerID);
    }

    const sim = params.Metadata ? params.Metadata.simulate : "";
    if (sim === SimulateNetwork) {
      if (!this.netFirst.has(params.IdempotencyKey)) {
        this.netFirst.add(params.IdempotencyKey);
        throw NewTransient(new Error("stub: upstream network timeout"));
      }
      // Retry with the same key settles normally (provider idempotency).
    }
    if (sim === SimulateDecline) {
      throw new PermanentError("stub: card declined");
    }

    this.nextID += 1;
    const id = "ch_" + String(this.nextID).padStart(6, "0");
    let status = ChargeSucceeded;
    if (sim === SimulateHold) status = ChargePending;
    const res = { id, status, amount: params.Amount, currency: params.Currency, last4: "4242" };
    this.charges.set(id, res);
    this.byIdemKey.set(params.IdempotencyKey, id);
    return res;
  }

  getCharge(providerChargeID) {
    const res = this.charges.get(providerChargeID);
    if (!res) throw new Error("stub: unknown charge " + providerChargeID);
    return res;
  }

  // refundCharge mirrors RefundCharge; idempotent, always succeeds.
  refundCharge(params) {
    if (this.refundByKey.has(params.IdempotencyKey)) {
      const providerID = this.refundByKey.get(params.IdempotencyKey);
      return this.refunds.get(providerID);
    }
    this.nextID += 1;
    const id = "re_" + String(this.nextID).padStart(6, "0");
    const res = { id, status: RefundSucceeded };
    this.refunds.set(id, res);
    this.refundByKey.set(params.IdempotencyKey, id);
    return res;
  }

  getRefund(providerRefundID) {
    const res = this.refunds.get(providerRefundID);
    if (!res) throw new Error("stub: unknown refund " + providerRefundID);
    return res;
  }
}

// NewStubGateway builds the deterministic stub provider.
function NewStubGateway() {
  return new StubGateway();
}

module.exports = {
  ChargePending, ChargeSucceeded, ChargeFailed, ChargeRefunded,
  RefundPending, RefundSucceeded, RefundFailed,
  SimulateNetwork, SimulateDecline, SimulateHold,
  TransientError, PermanentError, NewTransient, IsTransient, StubGateway, NewStubGateway,
};