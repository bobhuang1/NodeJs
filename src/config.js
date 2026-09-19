"use strict";

let raw = {};
try { raw = require("dotenv").config().parsed || {}; } catch (_) {}

function getnum(name, fallback) {
  const v = process.env[name] ?? raw[name];
  if (v === undefined || v === "") return fallback;
  if (!/^[0-9]+$/.test(v)) return fallback; // pure decimal digits only like Go getenvInt
  return parseInt(v, 10);
}
function getstr(name, fallback) {
  const v = process.env[name] ?? raw[name];
  if (v === undefined || v === "") return fallback;
  return v;
}

module.exports = {
  httpAddr: getstr("HTTP_ADDR", ":8080"),
  databaseURL: getstr(
    "DATABASE_URL",
    "postgres://shop:shop@localhost:5432/shop?sslmode=disable"
  ),
  redisAddr: getstr("REDIS_ADDR", "localhost:6379"),
  redisPassword: process.env.REDIS_PASSWORD ?? "", // no fallback, like Go
  jwtSecret: getstr("JWT_SECRET", "dev-secret-change-me"),
  jwtTTLMinutes: getnum("JWT_TTL_MINUTES", 60),
  jwtChallengeTTLMinutes: getnum("JWT_CHALLENGE_TTL_MINUTES", 5),
  totpIssuer: getstr("TOTP_ISSUER", "GoShop"),
  maxPaymentAttempts: getnum("MAX_PAYMENT_ATTEMPTS", 4),
  paymentRetryBaseDelayMs: getnum("PAYMENT_RETRY_BASE_DELAY_MS", 100),
  emailMaxAttempts: getnum("EMAIL_WORKER_MAX_ATTEMPTS", 5),
  emailBaseDelayMs: getnum("EMAIL_WORKER_BASE_DELAY_MS", 100),
  idemTTL: 10 * 60 * 1000, // IdemTTL = 10 * time.Minute
  cacheTTL: 60 * 1000, // products read-through 60s
  pwdTTL: 10 * 60 * 1000, // pwdreset 10m
  otpTTL: 5 * 60 * 1000, // JWT_CHALLENGE_TTL_MINUTES in redis (unused; in JWT)
};
