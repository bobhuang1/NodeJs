"use strict";
/* pg seam: thin wrapper around node-postgres that presents a tiny, mockable
 * surface (mirrors GoLang internal/store's pgxpool.Pool seam):
 *   pool.begin() -> tx { query, exec }   transaction (BEGIN/COMMIT/ROLLBACK)
 *   pool.queryRow(sql, args) -> row|null (exactly 0 or 1 row)
 *   pool.query(sql, args)   -> { rows, rowCount }
 *   pool.exec(sql, args)    -> { rowCount }
 * Tests swap this for a pgmock-style in-memory seam (test/db/pgmem.js) that
 * matches SQL text exactly (QueryMatcherEqual) and scripts ordered expectations. */
const { Pool } = require("pg");

class Tx {
  constructor(pool, id) { this.pool = pool; this.id = id; }
  async queryRow(sql, args) {
    return this.pool._queryTx(this.id, sql, args, true);
  }
  async query(sql, args) {
    return this.pool._queryTx(this.id, sql, args, false);
  }
  async exec(sql, args) {
    return this.pool._queryTx(this.id, sql, args, false);
  }
  async commit() { return this.pool._endTx(this.id, true); }
  async rollback() { return this.pool._endTx(this.id, false); }
}

class LeanPool {
  constructor(connStr, { onLog = console } = {}) {
    this.pg = new Pool({ connectionString: connStr, max: 20, idleTimeoutMillis: 30000 });
    this.onLog = onLog;
    this._txs = new Map();
    this._nextTx = 0;
  }
  async begin() {
    const client = await this.pg.connect();
    await client.query("BEGIN");
    const id = ++this._nextTx;
    this._txs.set(id, client);
    return new Tx(this, id);
  }
  async _queryTx(id, sql, args, single) {
    const client = this._txs.get(id);
    if (!client) throw Object.assign(new Error("no active transaction"), { transient: false });
    const r = await client.query(sql, args || []);
    if (single) return r.rows.length ? r.rows[0] : null;
    return r;
  }
  async _endTx(id, commit) {
    const client = this._txs.get(id);
    if (!client) return;
    try { await client.query(commit ? "COMMIT" : "ROLLBACK"); }
    finally { this._txs.delete(id); client.release(); }
  }
  async queryRow(sql, args) {
    const r = await this.pg.query(sql, args || []);
    return r.rows.length ? r.rows[0] : null;
  }
  async query(sql, args) { return this.pg.query(sql, args || []); }
  async exec(sql, args) { return this.pg.query(sql, args || []); }
  async ping() { await this.pg.query("SELECT 1"); }
  async close() { await this.pg.end(); }
}

module.exports = { LeanPool, Tx };
