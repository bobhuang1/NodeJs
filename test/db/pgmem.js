"use strict";
/* In-memory pool seam for node:test — mirrors the LeanPool surface
 * (queryRow/query/exec/begin) with ordered, text-exact SQL expectations like
 * the email worker's memPool (and GoLang's pgxmock). norm() collapses
 * whitespace only; every literal must otherwise match the source SQL 1:1. */
const assert = require("node:assert/strict");

function norm(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function memPool() {
  const expected = []; // { text, args?, rows?, rowCount? }
  function consume(method, sqlText, args) {
    const e = expected.shift();
    assert.ok(e, `unexpected ${method}: ${norm(sqlText)}`);
    assert.equal(norm(sqlText), norm(e.text), `${method} SQL mismatch`);
    if (e.args !== undefined) {
      assert.deepEqual(args, e.args, `${method} args mismatch`);
    }
    return e;
  }
  const pool = {
    eas: expected,
    expectSQL(text, { args, rows, rowCount } = {}) {
      expected.push({ text, args, rows, rowCount });
      return pool;
    },
    async queryRow(sqlText, args) {
      const e = consume("queryRow", sqlText, args);
      return e.rows ? e.rows[0] : null;
    },
    async query(sqlText, args) {
      const e = consume("query", sqlText, args);
      return {
        rows: e.rows || [],
        rowCount: e.rowCount != null ? e.rowCount : e.rows ? e.rows.length : 0,
      };
    },
    async exec(sqlText, args) {
      const e = consume("exec", sqlText, args);
      return { rowCount: e.rowCount != null ? e.rowCount : 1 };
    },
    async begin() {
      // Defer to the same ordered queue; commit/rollback are no-ops like Go's
      // deferred tx.Rollback on a committed transaction.
      return {
        queryRow(sqlText, args) { return pool.queryRow(sqlText, args); },
        query(sqlText, args) { return pool.query(sqlText, args); },
        exec(sqlText, args) { return pool.exec(sqlText, args); },
        async commit() {},
        async rollback() {},
      };
    },
  };
  return pool;
}

// DuplicateKeyError mimics pg's 23505 (unique_violation) for tx seams.
function duplicateKey(msg) {
  const e = new Error(msg || "duplicate key value violates unique constraint");
  e.code = "23505";
  return e;
}

module.exports = { memPool, norm, duplicateKey };