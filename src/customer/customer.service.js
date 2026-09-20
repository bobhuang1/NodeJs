"use strict";
/* customer service — NodeJs port of GoLang internal/customer/service.go VERBATIM:
 * SQL text, messages, the 10-minute password-reset TTL, soft-delete semantics,
 * and the 2FA enroll/verify/disable rules. Redis failures degrade to postgres. */
const crypto = require("node:crypto");
const { BadRequest, Forbidden, Conflict, NotFound, Wrap } = require("../httpx/respond.js");
const { HashPassword } = require("../auth/password.js");
const { ProvisionTOTP, VerifyTOTP } = require("../auth/totp.js");
const { isMiss } = require("../cache/redis.js");

const passwordResetTTL = 10 * 60 * 1000; // Go: passwordResetTTL = 10 * time.Minute

const BY_EMAIL_SQL =
  `SELECT id, email, full_name, password_hash, is_admin, totp_secret, totp_enabled, created_at, deleted_at
        FROM customers WHERE email = $1`;
const BY_ID_SQL =
  `SELECT id, email, full_name, password_hash, is_admin, totp_secret, totp_enabled, created_at, deleted_at
        FROM customers WHERE id = $1 AND deleted_at IS NULL`;
const PROFILE_SQL =
  `SELECT id, email, full_name, is_admin, totp_enabled, created_at
        FROM customers WHERE id = $1 AND deleted_at IS NULL`;

class Service {
  constructor(pool, cache) {
    this.pool = pool;
    this.cache = cache;
  }

  // Register creates a new customer account.
  async Register(email, password, fullName) {
    if (email === "" || password === "") {
      throw BadRequest("email and password are required");
    }
    let hash;
    try {
      hash = await HashPassword(password);
    } catch (err) {
      throw Wrap(err);
    }
    let row;
    try {
      row = await this.pool.queryRow(
        `INSERT INTO customers (email, password_hash, full_name)
        VALUES ($1, $2, $3)
        RETURNING id, email, full_name, is_admin, totp_enabled, created_at`,
        [email, hash, fullName]
      );
    } catch (err) {
      if (err && err.code === "23505") throw Conflict("email already registered");
      throw Wrap(err);
    }
    return toCustomer(row);
  }

  // GetWithCredentials fetches a customer including the password hash.
  async GetWithCredentials(email) {
    return this.getByEmail(email);
  }

  async getByEmail(email) {
    let row;
    try {
      row = await this.pool.queryRow(BY_EMAIL_SQL, [email]);
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("customer not found");
    if (row.deleted_at) throw NotFound("customer not found");
    return row;
  }

  async getByID(customerID) {
    let row;
    try {
      row = await this.pool.queryRow(BY_ID_SQL, [customerID]);
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("customer not found");
    return row;
  }

  // Get returns the public profile. Callers must have checked ownership.
  async Get(customerID) {
    let row;
    try {
      row = await this.pool.queryRow(PROFILE_SQL, [customerID]);
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("customer not found");
    return toCustomer(row);
  }

  // UpdateProfile updates a customer's profile. Only own account or admin.
  async UpdateProfile(customerID, fullName) {
    let tag;
    try {
      tag = await this.pool.exec(
        `UPDATE customers SET full_name = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [customerID, fullName]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (tag.rowCount === 0) throw NotFound("customer not found");
    return this.Get(customerID);
  }

  // Delete soft-deletes the account.
  async Delete(customerID) {
    let tag;
    try {
      tag = await this.pool.exec(
        `UPDATE customers SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [customerID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (tag.rowCount === 0) throw NotFound("customer not found");
  }

  // ForgotPassword issues a one-time reset code for the email.
  async ForgotPassword(email) {
    let row;
    try {
      row = await this.getByEmail(email);
    } catch (err) {
      // Uniform answer: do not leak whether the email exists.
      throw BadRequest("account not found");
    }
    if (row.deleted_at) {
      throw BadRequest("account not found");
    }
    const code = randomDigits(6);
    const key = "pwdreset:" + email;
    try {
      await this.cache.set(key, code, passwordResetTTL);
    } catch (err) {
      throw Wrap(new Error("store reset code: " + String(err)));
    }
    return code;
  }

  // ResetPassword validates the one-time code and rotates the password hash.
  async ResetPassword(email, code, newPassword) {
    const key = "pwdreset:" + email;
    let stored;
    try {
      stored = await this.cache.get(key);
    } catch (err) {
      if (isMiss(err)) throw BadRequest("invalid or expired reset code");
      throw Wrap(err);
    }
    if (String(stored) !== code) {
      throw BadRequest("invalid or expired reset code");
    }
    let hash;
    try {
      hash = await HashPassword(newPassword);
    } catch (err) {
      throw Wrap(err);
    }
    let tag;
    try {
      tag = await this.pool.exec(
        `UPDATE customers SET password_hash = $2, updated_at = now() WHERE email = $1 AND deleted_at IS NULL`,
        [email, hash]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (tag.rowCount === 0) throw NotFound("customer not found");
    // One-time code consumed.
    try {
      await this.cache.del(key); // best-effort
    } catch (err) { /* ignore */ }
  }

  // Enroll2FA provisions a TOTP secret and returns the otpauth URL.
  async Enroll2FA(customerID, email) {
    let secret;
    let otpauthURL;
    try {
      ({ secret, otpauth_url: otpauthURL } = await ProvisionTOTP(email));
    } catch (err) {
      throw Wrap(err);
    }
    let tag;
    try {
      tag = await this.pool.exec(
        `UPDATE customers SET totp_secret = $2, totp_enabled = FALSE, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
        [customerID, secret]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (tag.rowCount === 0) throw NotFound("customer not found");
    return { secret, otpauth_url: otpauthURL };
  }

  // Verify2FA validates a TOTP code and, when `activate` is set, enables 2FA.
  async Verify2FA(customerID, email, code, activate) {
    const row = await this.getByEmail(email);
    if (Number(row.id) !== customerID && !activate) {
      throw Forbidden("cannot verify 2FA for another customer");
    }
    if (!row.totp_secret) {
      throw Conflict("2FA not enrolled; call /auth/2fa/enroll first");
    }
    if (!VerifyTOTP(row.totp_secret, code)) {
      throw BadRequest("invalid authenticator code");
    }
    if (activate) {
      let tag;
      try {
        tag = await this.pool.exec(
          `UPDATE customers SET totp_enabled = TRUE, updated_at = now() WHERE id = $1`,
          [customerID]
        );
      } catch (err) {
        throw Wrap(err);
      }
      if (tag.rowCount === 0) throw NotFound("customer not found");
    }
  }

  // Disable2FA turns 2FA off after a valid code.
  async Disable2FA(customerID, code) {
    const row = await this.getByID(customerID);
    if (!row.totp_secret || !VerifyTOTP(row.totp_secret, code)) {
      throw BadRequest("invalid authenticator code");
    }
    let tag;
    try {
      tag = await this.pool.exec(
        `UPDATE customers SET totp_enabled = FALSE, updated_at = now() WHERE id = $1`,
        [customerID]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (tag.rowCount === 0) throw NotFound("customer not found");
  }
}

// toCustomer mirrors customerRow -> Customer (public shape). Exported for the
// login handler, which renders the account right after the password check.
function toCustomer(r) {
  return {
    id: Number(r.id),
    email: r.email,
    full_name: r.full_name,
    is_admin: !!r.is_admin,
    totp_enabled: !!r.totp_enabled,
    created_at: r.created_at,
  };
}

// randomDigits uses crypto/rand bytes mapped into 0-9, like the Go package.
function randomDigits(n) {
  const digits = "0123456789";
  const b = crypto.randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += digits[b[i] % digits.length];
  return out;
}

module.exports = { Service, toCustomer, passwordResetTTL };