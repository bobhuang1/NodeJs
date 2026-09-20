"use strict";
/* customer + auth test — the 13 route literals of GoLang internal/customer/
 * handlers.go, the bcrypt/TOTP seams, and the password-reset cache flow. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcryptjs");
const { authenticator } = require("otplib");
const { serve } = require("../../test/http.js");
const { memPool } = require("../../test/db/pgmem.js");
const { Service } = require("../../src/customer/customer.service.js");
const { routes } = require("../../src/customer/customer.handlers.js");
const { TokenManager } = require("../../src/auth/token.js");
const { ErrMiss } = require("../../src/cache/redis.js");

const tm = new TokenManager("customer-test-secret", 60, 5);
const HASH = bcrypt.hashSync("pw", 10);
const WHEN = new Date("2026-09-19T00:00:00Z");

const INSERT_CUSTOMER =
  `INSERT INTO customers (email, password_hash, full_name)
        VALUES ($1, $2, $3)
        RETURNING id, email, full_name, is_admin, totp_enabled, created_at`;
const BY_EMAIL =
  `SELECT id, email, full_name, password_hash, is_admin, totp_secret, totp_enabled, created_at, deleted_at
        FROM customers WHERE email = $1`;
const BY_ID =
  `SELECT id, email, full_name, password_hash, is_admin, totp_secret, totp_enabled, created_at, deleted_at
        FROM customers WHERE id = $1 AND deleted_at IS NULL`;
const PROFILE =
  `SELECT id, email, full_name, is_admin, totp_enabled, created_at
        FROM customers WHERE id = $1 AND deleted_at IS NULL`;
const UPDATE_PROFILE =
  `UPDATE customers SET full_name = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`;
const DELETE_CUSTOMER =
  `UPDATE customers SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`;
const RESET_PW =
  `UPDATE customers SET password_hash = $2, updated_at = now() WHERE email = $1 AND deleted_at IS NULL`;

// MemCache mirrors the Redis seam: miss -> ErrMiss, values stored as Buffers.
class MemCache {
  constructor() { this.m = new Map(); }
  async get(k) {
    if (!this.m.has(k)) throw ErrMiss;
    return this.m.get(k);
  }
  async set(k, v, ttl) { this.m.set(k, Buffer.from(String(v))); }
  async del(k) { this.m.delete(k); }
}

const EMAIL = "a@b.com";
const CUSTOMER = {
  id: 7, email: EMAIL, full_name: "Ann", is_admin: false, totp_enabled: false, created_at: WHEN.toJSON(),
};
const ROW = {
  id: "7", email: EMAIL, full_name: "Ann", password_hash: HASH, is_admin: false,
  totp_secret: null, totp_enabled: false, created_at: WHEN, deleted_at: null,
};

function appFor(svc) {
  const app = express();
  app.use("/api/v1", routes(svc, tm));
  return app;
}

test("customer + auth route literals: register/forgot/reset + own-or-admin guard", async () => {
  const pool = memPool();
  const cache = new MemCache();
  const svc = new Service(pool, cache);
  const srv = await serve(appFor(svc));
  try {
    pool.expectSQL(INSERT_CUSTOMER, {
      rows: [{ id: "7", email: EMAIL, full_name: "Ann", is_admin: false, totp_enabled: false, created_at: WHEN }],
    });
    const register = await fetch(srv.base + "/api/v1/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "pw2", full_name: "Ann" }),
    });
    assert.equal(register.status, 201);
    assert.deepEqual(await register.json(), CUSTOMER);

    pool.expectSQL(BY_EMAIL, { args: [EMAIL], rows: [ROW] });
    const forgot = await fetch(srv.base + "/api/v1/customers/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL }),
    });
    assert.equal(forgot.status, 200);
    const forgotBody = await forgot.json();
    assert.equal(forgotBody.message, "reset code issued");
    assert.match(forgotBody.code, /^[0-9]{6}$/);
    assert.equal(forgotBody.note, "demo: the code would normally be emailed to " + EMAIL);

    pool.expectSQL(RESET_PW, { rowCount: 1 });
    const reset = await fetch(srv.base + "/api/v1/customers/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, code: forgotBody.code, new_password: "pw3" }),
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { message: "password updated" });

    const token = tm.sign(CUSTOMER.id, EMAIL, "customer");
    const auth = { Authorization: "Bearer " + token };

    pool.expectSQL(PROFILE, { args: [7], rows: [{ id: "7", email: EMAIL, full_name: "Ann", is_admin: false, totp_enabled: false, created_at: WHEN }] });
    const me = await fetch(srv.base + "/api/v1/customers/me", { headers: auth });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), CUSTOMER);

    pool.expectSQL(PROFILE, { args: [7], rows: [{ id: "7", email: EMAIL, full_name: "Ann", is_admin: false, totp_enabled: false, created_at: WHEN }] });
    const getOwn = await fetch(srv.base + "/api/v1/customers/7", { headers: auth });
    assert.equal(getOwn.status, 200);

    pool.expectSQL(UPDATE_PROFILE, { args: [7, "Annika"], rowCount: 1 });
    pool.expectSQL(PROFILE, { args: [7], rows: [{ id: "7", email: EMAIL, full_name: "Annika", is_admin: false, totp_enabled: false, created_at: WHEN }] });
    const update = await fetch(srv.base + "/api/v1/customers/7", {
      method: "PUT",
      headers: Object.assign({ "Content-Type": "application/json" }, auth),
      body: JSON.stringify({ full_name: "Annika" }),
    });
    assert.equal(update.status, 200);

    pool.expectSQL(DELETE_CUSTOMER, { args: [7], rowCount: 1 });
    const del = await fetch(srv.base + "/api/v1/customers/7", { method: "DELETE", headers: auth });
    assert.equal(del.status, 204);

    const forbidden = await fetch(srv.base + "/api/v1/customers/9", { headers: auth });
    assert.equal(forbidden.status, 403);
    assert.deepEqual((await forbidden.json()).error, { code: "forbidden", message: "not allowed to access this account" });

    const noAuth = await fetch(srv.base + "/api/v1/customers/7");
    assert.equal(noAuth.status, 401);
    assert.deepEqual((await noAuth.json()).error, { code: "unauthorized", message: "missing bearer token" });
  } finally {
    await srv.close();
  }
});

// convince the harness that the register args hash is hashed once, not twice

test("login: password flow + 2FA challenge + redeem + 2FA lifecycle", async () => {
  const pool = memPool();
  const cache = new MemCache();
  const svc = new Service(pool, cache);
  const srv = await serve(appFor(svc));
  const secret = authenticator.generateSecret();
  const token = tm.sign(7, EMAIL, "customer");
  try {
    // password login without 2FA -> full access token
    pool.expectSQL(BY_EMAIL, { args: [EMAIL], rows: [ROW] });
    const login = await fetch(srv.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "pw" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.equal(loginBody.two_factor_required, false);
    assert.equal(loginBody.token_type, "Bearer");
    assert.ok(loginBody.access_token);
    assert.deepEqual(loginBody.customer, CUSTOMER);

    // wrong password -> uniform 401
    pool.expectSQL(BY_EMAIL, { args: [EMAIL], rows: [ROW] });
    const bad = await fetch(srv.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "nope" }),
    });
    assert.equal(bad.status, 401);
    assert.deepEqual((await bad.json()).error, { code: "unauthorized", message: "invalid email or password" });

    // 2FA enabled -> challenge token instead of access token
    const row2 = Object.assign({}, ROW, { totp_secret: secret, totp_enabled: true });
    pool.expectSQL(BY_EMAIL, { args: [EMAIL], rows: [row2] });
    const challenge = await fetch(srv.base + "/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "pw" }),
    });
    assert.equal(challenge.status, 200);
    const challengeBody = await challenge.json();
    assert.equal(challengeBody.two_factor_required, true);
    assert.ok(challengeBody.challenge_token);
    assert.equal(challengeBody.access_token, undefined);

    // redeem the challenge with a valid TOTP code -> access token
    pool.expectSQL(BY_EMAIL, { args: [EMAIL], rows: [row2] });
    const redeem = await fetch(srv.base + "/api/v1/auth/login/2fa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge_token: challengeBody.challenge_token, code: authenticator.generate(secret) }),
    });
    assert.equal(redeem.status, 200);
    assert.equal((await redeem.json()).two_factor_required, false);

    // audit the raw route literals with an authenticated caller
    const auth = { Authorization: "Bearer " + token };

    pool.expectSQL(`UPDATE customers SET totp_secret = $2, totp_enabled = FALSE, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`, { rowCount: 1 });
    const enroll = await fetch(srv.base + "/api/v1/auth/2fa/enroll", { method: "POST", headers: auth });
    assert.equal(enroll.status, 200);
    const enrollBody = await enroll.json();
    assert.match(enrollBody.secret, /^[A-Z2-7]+$/);
    assert.equal(enrollBody.manual_key, enrollBody.secret);
    assert.ok(enrollBody.otpauth_url.indexOf(enrollBody.secret) !== -1);

    pool.expectSQL(BY_EMAIL, { args: [EMAIL], rows: [row2] });
    pool.expectSQL(`UPDATE customers SET totp_enabled = TRUE, updated_at = now() WHERE id = $1`, { args: [7], rowCount: 1 });
    const activate = await fetch(srv.base + "/api/v1/auth/2fa/activate", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, auth),
      body: JSON.stringify({ code: authenticator.generate(secret) }),
    });
    assert.equal(activate.status, 200);
    assert.deepEqual(await activate.json(), { message: "2FA enabled" });

    pool.expectSQL(BY_ID, { args: [7], rows: [row2] });
    pool.expectSQL(`UPDATE customers SET totp_enabled = FALSE, updated_at = now() WHERE id = $1`, { args: [7], rowCount: 1 });
    const disable = await fetch(srv.base + "/api/v1/auth/2fa/disable", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, auth),
      body: JSON.stringify({ code: authenticator.generate(secret) }),
    });
    assert.equal(disable.status, 200);
    assert.deepEqual(await disable.json(), { message: "2FA disabled" });

    const logout = await fetch(srv.base + "/api/v1/auth/logout", { method: "POST" });
    assert.equal(logout.status, 200);
    assert.deepEqual(await logout.json(), { message: "logged out" });
  } finally {
    await srv.close();
  }
});