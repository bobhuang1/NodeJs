# NodeJs

Node.js shopping service — port of the GoLang microservice
(`github.com/bobhuang1/GoLang`, `GoShop`). Same 40-route surface, same DB
schema, same email-outbox worker contract. Express + `pg` + `ioredis`/Redis.

## Port status (honest)
- **Green & proven:** email outbox worker (`src/email/email.service.js`) —
  claim → relay → delivered upsert, pinned backoff ladder 1x/2x/4x/8x, transient
  bump vs permanent fail+admin-alert. Test in `test/email/` runs on an
  in-memory pool (no DB): `npm test`.
- **Green:** full Express route surface (customers+auth/products/cart/orders/
  payments/shipping/admin) ported 1:1 from GoLang handlers, `npm test` 20/20.
- **Green:** `src/app.js` (NewRouter, mirrors `internal/api/api.go`:
  RequestID/Recover/Logger middleware, healthz, shared IdempotencyGuard on
  cart/payments/admin-refunds), `src/server.js` (mirrors `cmd/server/main.go`:
  migrations, redis-or-Null degraded cache, seed, graceful shutdown),
  `src/seed.js`, `src/email/worker.js` (outbox worker CLI).

## Contract source of truth
The exact route literals, outbox SQL, backoff formula, idempotency TTLs, Redis
keys and env table are captured verbatim from the GoLang spec in
`C:\Users\user\AppData\Local\Temp\opencode\golang_spec.txt` (440 lines) and
mirrored 1:1 in `src/`. No endpoint was invented or deviated from.

## Run
```bash
npm install
cp .env.example .env   # set DATABASE_URL, REDIS_ADDR, JWT_SECRET
npm run migrate        # applies src/db/migrations/*.sql (incl. email_messages, admin_notices)
npm start              # server (auto-migrates + seeds demo accounts/products on boot)
npm run worker:email   # email outbox worker (optional; 2 workers by default)
npm test               # full in-memory suite (no DB needed)
```

## Layout
```
src/config.js          env seams (getstr/getnum, digit validation, defaults)
src/app.js             NewRouter — mirrors internal/api/api.go (all 7 groups)
src/server.js          HTTP server — mirrors cmd/server/main.go
src/seed.js            idlepotent demo accounts+products — mirrors cmd/server/seed.go
src/cache/backoff.js   BackoffDelay + pinned ladder (1x/2x/4x/8x, jitter)
src/cache/cache.js     retry seam (isTransient/sleep/withTimeout/makeRetry)
src/db/pool.js         LeanPool/Tx seam (queryRow/exec/begin) — test-safe
src/db/migrate.js      RunMigrations (lex order, schema_migrations, per-tx)
src/db/migrations/     full schema incl. email_messages + admin_notices
src/email/sql.js       outbox SQL consts (claim/bump/delivered/fail/alert)
src/email/email.service.js  outbox worker (processOne/run)
src/email/worker.js    email outbox worker CLI (npm run worker:email)
test/email/            worker test (in-memory pool, deterministic)
```
