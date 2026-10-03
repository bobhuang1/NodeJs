"use strict";
/* IdempotencyGuard scoping + credential rate limiter. */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { serve } = require("../../test/http.js");
const { IdempotencyGuard } = require("../../src/httpx/idempotency.js");
const { rateLimiter } = require("../../src/httpx/ratelimit.js");

test("idempotency guard: per caller, POST only, successes only", async () => {
  let calls = 0;
  let status = 201;
  const app = express();
  app.use(new IdempotencyGuard(60000, 100).middleware());
  app.all("/charges", (req, res) => {
    calls += 1;
    res.status(status).send(req.get("authorization") || "");
  });
  const srv = await serve(app);
  const call = (method, auth, key) =>
    fetch(srv.base + "/charges", { method, headers: { Authorization: auth, "Idempotency-Key": key } });
  try {
    const first = await (await call("POST", "Bearer alice", "k1")).text();
    const replay = await call("POST", "Bearer alice", "k1");
    assert.equal(replay.headers.get("x-idempotent-replay"), "true");
    assert.equal(await replay.text(), first);
    assert.equal(calls, 1);

    assert.equal(await (await call("POST", "Bearer bob", "k1")).text(), "Bearer bob");
    assert.equal(calls, 2);

    status = 500;
    await call("POST", "Bearer alice", "k2");
    await call("POST", "Bearer alice", "k2");
    assert.equal(calls, 4);

    status = 200;
    await call("GET", "Bearer alice", "k3");
    await call("GET", "Bearer alice", "k3");
    assert.equal(calls, 6);
  } finally {
    await srv.close();
  }
});

test("rate limiter: 429 after the limit", async () => {
  const app = express();
  app.post("/login", rateLimiter(2, 60000), (req, res) => res.sendStatus(200));
  const srv = await serve(app);
  try {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(srv.base + "/login", { method: "POST" })).status);
    assert.deepEqual(codes, [200, 200, 429]);
  } finally {
    await srv.close();
  }
});
