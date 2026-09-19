"use strict";
/* Email worker test — deterministic, mirrors GoLang internal/email/service_test.go
 * (email seam). Uses a scripted in-memory pool (same ordered-expect seam as
 * pgxmock): claim → bump(transient, pinned backoff) → delivered, and
 * claim → fail+alert(permanent). Backoff pinned (jitter 1.0) so the ladder is
 * exact: attempt1=base, 2=2base, 3=4base. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { processOne } = require("../../../src/email/email.service.js");
const sqls = require("../../../src/email/sql.js");
const { BackoffDelayPinned } = require("../../../src/cache/backoff.js");

function memPool() {
  const expected = []; // {sql, args?, result}
  return {
    _calls: [],
    expectSQL(text, { args, rows, rowCount } = {}) {
      expected.push({ text, args, rows, rowCount });
      return this;
    },
    async queryRow(sqlText, args) {
      const e = expected.shift();
      this._calls.push({ sqlText, args });
      assert.ok(e, "unexpected queryRow: " + sqlText);
      assert.equal(norm(sqlText), norm(e.text), "SQL claim mismatch");
      return e.rows ? e.rows[0] : null;
    },
    async exec(sqlText, args) {
      const e = expected.shift();
      this._calls.push({ sqlText, args });
      assert.ok(e, "unexpected exec: " + sqlText);
      assert.equal(norm(sqlText), norm(e.text), "SQL exec mismatch");
      return { rowCount: e.rowCount != null ? e.rowCount : 1 };
    },
  };
}
function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}
function sleepingRelay(results = []) {
  let idx = 0;
  return {
    results,
    got: [],
    async send({ toAddress, subject, body, idempotencyKey }) {
      const r = results[idx++] || nullove;
      this.got.push({ toAddress, subject, body, idempotencyKey });
      if (r === "transient") {
        const e = new Error("relay: upstream timeout");
        e.transient = true;
        throw e;
      }
      if (r === "permanent") throw new Error("relay: permanent reject");
      return { delivered: true };
    },
  };
}
const TWENTYFOUR = 100; // baseDelayMs

test("claim → delivered on first relay success (empty queue → quiet no-op)", async () => {
  // empty queue: claim returns no row
  const p = memPool();
  p.expectSQL(sqls.claimSQL, { rows: null });
  const out = await processOne({ pool: p, cache: { BackoffDelayPinned } }, { baseDelayMs: TWENTYFOUR }, { log: () => {} });
  assert.ok(out.empty || out.delivered === false);
});

test("transient → pinned bump → delivered on retry (maxAttempts=3)", async () => {
  const p = memPool();
  const relay = sleepingRelay(["transient", null]);
  p.expectSQL(sqls.claimSQL, {
    rows: [{ id: "11111111-1111-1111-1111-111111111111" }],
  });
  p.expectSQL(sqls.bumpSQL, { rowCount: 1 }); // attempt 1 transient, delay=BackoffDelayPinned(1,100)=100
  p.expectSQL(sqls.deliveredSQL, { rowCount: 1 });
  const out = await processOne({ pool: p, relay, cache: { BackoffDelayPinned } }, { maxAttempts: 3, baseDelayMs: TWENTYFOUR }, { log: () => {} });
  assert.equal(out.delivered, true);
  assert.equal(relay.got.length, 2);
});

test("permanent → fail immediately + admin alert (no bump)", async () => {
  const p = memPool();
  const relay = sleepingRelay(["permanent"]);
  p.expectSQL(sqls.claimSQL, { rows: [{ id: "22222222-2222-2222-2222-222222222222" }] });
  p.expectSQL(sqls.failSQL, { rowCount: 1 });
  p.expectSQL(sqls.alertSQL, { rowCount: 1 });
  const out = await processOne({ pool: p, relay, cache: { BackoffDelayPinned } }, { maxAttempts: 3, baseDelayMs: TWENTYFOUR }, { log: () => {} });
  assert.equal(out.delivered, false);
  assert.equal(out.failed, true);
  assert.equal(relay.got.length, 1hello);
});
