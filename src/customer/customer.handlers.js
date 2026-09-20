"use strict";
/* customer + auth handlers — NodeJs port of GoLang internal/customer/handlers.go
 * VERBATIM. Routes() mounts /auth (login, login/2fa, logout, 2fa/*) and
 * /customers (register, forgot/reset-password, own-or-admin CRUD). */
const express = require("express");
const httpx = require("../httpx/respond.js");
const { requireAuth } = require("../httpx/auth.js");
const { ChallengeKind, RoleAdmin, RoleCustomer } = require("../auth/token.js");
const { CheckPassword } = require("../auth/password.js");
const { toCustomer } = require("../customer/customer.service.js");

function roleOf(isAdmin) {
  return isAdmin ? RoleAdmin : RoleCustomer;
}

// guard wraps every handler so thrown errors always resolve to an error body
// instead of leaving the request hanging (Express 4 has no async catch).
function guard(fn) {
  return (req, res) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch((err) => httpx.writeError(res, err));
  };
}

// route(id, fn) parses the path id and applies the requireOwnOrAdmin rule from
// Go's handler.go, then runs fn(req, res, id) through guard.
function ownRoute(fn) {
  return (req, res) => {
    const parsed = httpx.parsePathID(req, "id");
    if (!parsed.ok) {
      httpx.writeError(res, parsed.err);
      return;
    }
    const user = req.user;
    if (!user) {
      httpx.writeError(res, httpx.Unauthorized("authentication required"));
      return;
    }
    if (user.customer_id !== parsed.id && user.role !== RoleAdmin) {
      httpx.writeError(res, httpx.Forbidden("not allowed to access this account"));
      return;
    }
    guard((_req, _res) => fn(_req, _res, parsed.id))(req, res);
  };
}

// ----- register / profile ---------------------------------------------------

async function register(svc, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const c = await svc.Register(in_.email ?? "", in_.password ?? "", in_.full_name ?? "");
  httpx.writeCreated(res, c);
}

async function me(svc, req, res) {
  const user = req.user;
  const c = await svc.Get(user.customer_id);
  httpx.writeOK(res, c);
}

async function get(svc, req, res, id) {
  const c = await svc.Get(id);
  httpx.writeOK(res, c);
}

async function update(svc, req, res, id) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const c = await svc.UpdateProfile(id, in_.full_name ?? "");
  httpx.writeOK(res, c);
}

async function remove(svc, req, res, id) {
  await svc.Delete(id);
  httpx.writeNoContent(res);
}

// ----- forgot / reset password ----------------------------------------------

async function forgotPassword(svc, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const code = await svc.ForgotPassword(in_.email ?? "");
  // Demo only: the code would be emailed. Returning it makes the sample
  // runnable end-to-end without an SMTP server.
  httpx.writeOK(res, {
    message: "reset code issued",
    code,
    note: "demo: the code would normally be emailed to " + (in_.email ?? ""),
  });
}

async function resetPassword(svc, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  await svc.ResetPassword(in_.email ?? "", in_.code ?? "", in_.new_password ?? "");
  httpx.writeOK(res, { message: "password updated" });
}

// ----- login / 2FA ----------------------------------------------------------

async function login(svc, tokens, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  let row;
  try {
    row = await svc.GetWithCredentials(in_.email ?? "");
  } catch (err) {
    // Uniform message to avoid leaking account existence.
    httpx.writeError(res, httpx.Unauthorized("invalid email or password"));
    return;
  }
  if (!CheckPassword(row.password_hash, in_.password ?? "")) {
    httpx.writeError(res, httpx.Unauthorized("invalid email or password"));
    return;
  }

  const c = toCustomer(row);
  if (!c.totp_enabled) {
    const token = tokens.sign(c.id, c.email, roleOf(c.is_admin));
    httpx.writeOK(res, {
      access_token: token,
      token_type: "Bearer",
      two_factor_required: false,
      challenge_token: undefined,
      customer: c,
    });
    return;
  }

  // Password verified but 2FA is enabled: hand out a short-lived challenge.
  const challenge = tokens.signChallenge(c.id, c.email, roleOf(c.is_admin));
  httpx.writeOK(res, {
    access_token: undefined,
    token_type: undefined,
    two_factor_required: true,
    challenge_token: challenge,
    customer: undefined,
  });
}

async function login2FA(svc, tokens, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  let claims;
  try {
    claims = tokens.parse(in_.challenge_token ?? "");
  } catch (err) {
    httpx.writeError(res, httpx.Unauthorized("invalid challenge token"));
    return;
  }
  if (!ChallengeKind(claims)) {
    httpx.writeError(res, httpx.Unauthorized("invalid challenge token"));
    return;
  }
  const subject = Number.parseInt(claims.sub, 10);
  if (!Number.isInteger(subject)) {
    httpx.writeError(res, httpx.Unauthorized("invalid challenge token"));
    return;
  }
  try {
    await svc.Verify2FA(subject, claims.email, in_.code ?? "", false);
  } catch (err) {
    httpx.writeError(res, err);
    return;
  }
  const token = tokens.sign(subject, claims.email, claims.role);
  httpx.writeOK(res, {
    access_token: token,
    token_type: "Bearer",
    two_factor_required: false,
    challenge_token: undefined,
    customer: undefined,
  });
}

async function logout(req, res) {
  // Stateless JWTs: nothing to invalidate server-side.
  httpx.writeOK(res, { message: "logged out" });
}

async function enroll2FA(svc, req, res) {
  const user = req.user;
  const { secret, otpauth_url } = await svc.Enroll2FA(user.customer_id, user.email);
  httpx.writeOK(res, { secret, otpauth_url, manual_key: secret });
}

async function activate2FA(svc, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const user = req.user;
  await svc.Verify2FA(user.customer_id, user.email, in_.code ?? "", true);
  httpx.writeOK(res, { message: "2FA enabled" });
}

async function disable2FA(svc, req, res) {
  const in_ = await httpx.decodeJSON(req, res);
  if (in_ === null) return;
  const user = req.user;
  await svc.Disable2FA(user.customer_id, in_.code ?? "");
  httpx.writeOK(res, { message: "2FA disabled" });
}

// ----- routing --------------------------------------------------------------

function routes(svc, tokens) {
  const r = express.Router();

  const authRoutes = express.Router();
  authRoutes.post("/login", guard((req, res) => login(svc, tokens, req, res)));
  authRoutes.post("/login/2fa", guard((req, res) => login2FA(svc, tokens, req, res)));
  authRoutes.post("/logout", guard(logout));

  const auth2 = express.Router();
  auth2.use(requireAuth(tokens));
  auth2.post("/2fa/enroll", guard((req, res) => enroll2FA(svc, req, res)));
  auth2.post("/2fa/activate", guard((req, res) => activate2FA(svc, req, res)));
  auth2.post("/2fa/disable", guard((req, res) => disable2FA(svc, req, res)));
  authRoutes.use(auth2);
  r.use("/auth", authRoutes);

  const cRoutes = express.Router();
  cRoutes.post("/", guard((req, res) => register(svc, req, res)));
  cRoutes.post("/forgot-password", guard((req, res) => forgotPassword(svc, req, res)));
  cRoutes.post("/reset-password", guard((req, res) => resetPassword(svc, req, res)));

  const cAuth = express.Router();
  cAuth.use(requireAuth(tokens));
  cAuth.get("/me", guard((req, res) => me(svc, req, res)));
  cAuth.get("/:id", ownRoute((req, res, id) => get(svc, req, res, id)));
  cAuth.put("/:id", ownRoute((req, res, id) => update(svc, req, res, id)));
  cAuth.delete("/:id", ownRoute((req, res, id) => remove(svc, req, res, id)));
  cRoutes.use(cAuth);
  r.use("/customers", cRoutes);

  return r;
}

module.exports = { routes, roleOf };