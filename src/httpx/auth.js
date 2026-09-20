"use strict";
/* auth middleware seam — NodeJs port of GoLang internal/httpx/middleware.go
 * (RequireAuth / RequireAdmin / bearer / parseSubject). The token manager lives
 * in src/auth/token.js (mirrors internal/auth.TokenManager). req.user carries
 * { customer_id, email, role } like httpx.ContextUser. */
const { Unauthorized, Forbidden, writeError } = require("./respond.js");
const { RoleAdmin } = require("../auth/token.js");

function bearer(req) {
  const raw = req.get("authorization") || "";
  const prefix = "Bearer ";
  if (raw.length < prefix.length || raw.slice(0, prefix.length) !== prefix) return null;
  return raw.slice(prefix.length);
}

function parseSubject(s) {
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

// RequireAuth verifies the Bearer token and stores the caller on req.user.
function requireAuth(tokens) {
  return function requireAuthMW(req, res, next) {
    const token = bearer(req);
    if (!token) {
      writeError(res, Unauthorized("missing bearer token"));
      return;
    }
    let claims;
    try {
      claims = tokens.parse(token);
    } catch (e) {
      writeError(res, Unauthorized("invalid or expired token"));
      return;
    }
    req.user = {
      customer_id: parseSubject(claims.sub),
      email: claims.email,
      role: claims.role,
    };
    next();
  };
}

// RequireAdmin restricts a route to authenticated admins.
function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user) {
    writeError(res, Unauthorized("authentication required"));
    return;
  }
  if (user.role !== RoleAdmin) {
    writeError(res, Forbidden("administrator role required"));
    return;
  }
  next();
}

module.exports = { bearer, parseSubject, requireAuth, requireAdmin };