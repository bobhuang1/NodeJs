"use strict";
/* TOTP seam — NodeJs port of GoLang internal/auth/totp.go (pquerna/otp/totp).
 * otplib defaults match pquerna's TOTP: SHA1, 6 digits, 30s period.
 * Issuer from config (totpIssuer, default "GoShop"). */
const { authenticator } = require("otplib");
const { totpIssuer } = require("../config.js");

// NewTOTPSecret generates a base32 recovery/seed secret (AccountName "customer").
async function NewTOTPSecret() {
  const secret = authenticator.generateSecret();
  return secret;
}

// ProvisionTOTP returns a (secret, otpauth URL) pair before activation.
async function ProvisionTOTP(email) {
  const secret = authenticator.generateSecret();
  const otpauthURL = authenticator.keyuri(email, totpIssuer, secret);
  return { secret, otpauth_url: otpauthURL };
}

// VerifyTOTP validates a 6-digit code against the secret with a small window.
function VerifyTOTP(secret, code) {
  if (!secret || !code) return false;
  try {
    return authenticator.check(code, secret);
  } catch (e) {
    return false;
  }
}

module.exports = { NewTOTPSecret, ProvisionTOTP, VerifyTOTP };