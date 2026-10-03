"use strict";
/* Fixed-window, per-client-IP rate limiter for the credential endpoints (login, 2FA,
 * forgot/reset password). In-memory: with several instances each counts separately;
 * put a shared limiter (gateway, Redis) in front for that. */
const { writeError, APIError } = require("./respond.js");

function rateLimiter(limit, windowMs) {
  const hits = new Map(); // ip -> { start, count }
  return function rateLimitMW(req, res, next) {
    const now = Date.now();
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (now - v.start >= windowMs) hits.delete(k);
    }
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
    let w = hits.get(ip);
    if (!w || now - w.start >= windowMs) {
      w = { start: now, count: 0 };
      hits.set(ip, w);
    }
    w.count += 1;
    if (w.count > limit) {
      res.set("Retry-After", String(Math.ceil((w.start + windowMs - now) / 1000)));
      writeError(res, new APIError(429, "rate_limited", "too many attempts, try again later"));
      return;
    }
    next();
  };
}

module.exports = { rateLimiter };
