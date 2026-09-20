"use strict";
/* JWT seam — NodeJs port of GoLang internal/auth/token.go VERBATIM (claims,
 * kinds, issuer, HS256, expiry semantics). jsonwebtoken stands in for
 * golang-jwt/v5; subject is the stringified customer id (sub), iss "go-shop". */
const jwt = require("jsonwebtoken");

// Roles understood by the authorization middleware.
const RoleCustomer = "customer";
const RoleAdmin = "admin";
// TokenKindChallenge: short-lived token handed out right after a successful
// password login when 2FA is enabled; only redeemable by /auth/2fa/verify.
const TokenKindFull = "full";
const TokenKindChallenge = "2fa_challenge";

class TokenManager {
  constructor(secret, ttlMinutes, challengeTTLMinutes) {
    this.secret = secret;
    this.ttlMinutes = ttlMinutes;
    this.challengeTTLMinutes = challengeTTLMinutes;
  }
  // sign issues a full access token for the customer.
  sign(customerID, email, role) {
    return this.signKind(customerID, email, role, TokenKindFull, this.ttlMinutes);
  }
  // signChallenge issues a short-lived token that proves the password step.
  signChallenge(customerID, email, role) {
    return this.signKind(customerID, email, role, TokenKindChallenge, this.challengeTTLMinutes);
  }
  signKind(customerID, email, role, kind, ttlMinutes) {
    return jwt.sign(
      { email, role, kind },
      this.secret,
      {
        algorithm: "HS256",
        subject: String(customerID),
        issuer: "go-shop",
        expiresIn: ttlMinutes * 60, // seconds, like Go's time.Duration TTL
      }
    );
  }
  // parse validates a token and returns its claims.
  parse(raw) {
    return jwt.verify(raw, this.secret, { algorithms: ["HS256"] });
  }
}

// ChallengeKind reports whether the claims are a short-lived 2FA challenge.
function ChallengeKind(claims) {
  return !!(claims && claims.kind === TokenKindChallenge);
}

module.exports = { TokenManager, RoleCustomer, RoleAdmin, TokenKindFull, TokenKindChallenge, ChallengeKind };