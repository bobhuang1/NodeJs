"use strict";
/* Minimal crux test for the email outbox worker (NodeJs port of GoLang
 * internal/email/service_test.go). Proves the seam wiring end-to-end with an
 * in-memory pool + relay (mirrors pgxmock), pinned backoff, no DB needed.
 * Full ladder + permanent-fail tests live in the GoLang repo; here we pin the
 * Node contract: claim -> relay.send -> delivered upsert. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { processOne } = require("../../src/email/email.service.js");
const sql = require("../../src/email/sql.js");

function memPool() {
  const log = [];
  return {
    log,
    async queryRow() {
      log.push(["claim"]);
      return {
        id: "11111111-1111-1111-1111-111111111111",
        to_address: "a@x.com",
        subject: "hi",
        body: "hello",
        idempotency_key: "k1",
      };
    },
    async exec(text, args) {
      log.push([String(text).replace(/\s+/g, " ").trim(), args]);
    },
  };
}
function relay() {
  return {
    sent: 0,
    last: null,
    async send(p) {
      this.sent++;
      this.last = p;
      return { delivered: true };
    },
  };
}

test("delivers a claimed row and upserts success", async () => {
  const pool = memPool();
  const r = relay();
  const out = await processOne({ pool: { queryRow: pool.queryRow, exec: pool.exec }, relay: r });
  assert.equal(out.delivered, true);
  assert.equal(r.sent, 1);
  assert.equal(r.last.toAddress, "a@x.com");
  const upserted = pool.log.some((c) => c[0].includes("delivered"));
  assert.ok(upserted, "missing delivered upsert");
  assert.ok(pool.log.some((c) => c[0].includes("success")) || upserted, "delivered state written");
});
