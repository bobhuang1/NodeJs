"use strict";
/* DB seam. In prod wraps node-postgres Pool; in tests a mock pool registers the
 * same promises. Mirrors GoLang internal/store (pgxmock-style contract: Query/Exec
 * match exact SQL text, ordered). */
const pg = require("pg");

const isTransientMessage = /(connect|timeout|connection|refused|ECONN|ETIMEDOUT|read ECONNRESET|terminating connection|could not|temporar|temporary|pool has been closed)/i;

class DBError extends Error {
  constructor(message, { code = "500", status = 500, fields = {}, prev = null } = {}) {
    super(message);
    this.name = "DBError";
    this.code = code;
    this.status = status;
    this.fields = fields;
    this.prev = prev;
    this.transient = isTransientMessage.test(message || "");
  }
}
DBError.prototype.isDBError = true;

function wrapDB(err, fallbackStatus = 500) {
  if (err && err.isDBError) return err;
  return new DBError(err && err.message ? err.message : String(err), {
    code: "internal_error",
    status: fallbackStatus,
    prev: err,
  });
}

const DBTypes = {
  get pool() {
    return pg.Pool;
  },
};

class MockRows {
  constructor(fields, rows) {
    this.fields = fields;
    this.rows = rows || [];
  }
  read() {
    return this.rows;
  }
}

module.exports = { pg, DBError, wrapDB, MockRows, DBTypes, isTransientMessage };
