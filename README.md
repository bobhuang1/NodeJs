# NodeJs — GoShop port

Node.js shopping service — a 1:1 port of the GoLang microservice
(`github.com/bobhuang1/GoLang`, "GoShop"): the same 40-endpoint HTTP surface,
the same PostgreSQL schema, the same idempotency/retry/backoff discipline, and
the same email outbox worker contract.

Stack: **Node 20+ · Express 4 · pg · ioredis/redis · jsonwebtoken · otplib ·
bcryptjs**. Tests run fully in-memory (no database or Redis required).

## Port status

**Code-complete, test-green.** Every route literal, handler behaviour, SQL
string, error message, status code and envelope shape was read verbatim from the
GoLang sources and ported 1:1. `npm test` runs **20/20** tests green, including
HTTP-level suites for every route group (in-memory `pg` seam + real Express
mounts).

### Route surface (40 total)

| Group | Source | Routes |
|---|---|---|
| healthz | `src/app.js` | `GET /healthz` |
| customers + auth | `src/customer/` | 13 |
| products | `src/product/` | 5 |
| cart | `src/cart/` | 6 |
| orders | `src/order/` | 4 |
| payments | `src/payment/` | 6 |
| shipping | `src/shipping/` | 5 |

The full literal-by-literal contract lives in `ROUTES.md`.

### Boot wiring (matches the GoLang binary)

| GoLang | NodeJs |
|---|---|
| `internal/api/api.go` | `src/app.js` — `NewRouter(deps)` |
| `cmd/server/main.go` | `src/server.js` |
| `cmd/server/seed.go` | `src/seed.js` |
| `internal/email Service.Run` | `src/email/worker.js` CLI |

`src/server.js` mirrors `main.go` exactly: pool → embedded migrations on boot →
Redis cache (falls back to a **no-op Null cache when Redis is unreachable**,
"degraded mode") → token manager → services → **seed** (demo accounts +
products) → router → HTTP listen with graceful shutdown. A single shared
`IdempotencyGuard` wraps cart, payments and admin/refunds, and the middleware
stack is RequestID → Recover → Logger, as in `api.go`.

## Architecture

Handlers are thin; every domain rule lives in a service (`src/<domain>/*.service.js`)
that depends only on narrow, injectable seams:

- **HTTP** — `src/httpx/respond.js` (envelope `{error:{code,message}}`, 1 MiB
  body cap, `decodeJSON`, `parsePathID`/`parsePathUUID`), `src/httpx/auth.js`
  (Bearer `RequireAuth`/`RequireAdmin`), `src/httpx/idempotency.js` (in-memory
  replay guard, `X-Idempotent-Replay`).
- **Database** — `src/db/pool.js` (`LeanPool`/`Tx`: `query`/`queryRow`/`exec`/
  `begin`), `src/db/migrate.js` (lex-ordered, per-transaction migrations),
  `src/db/migrations/001_init.sql`.
- **Cache** — `src/cache/redis.js` (retry wrapper, `ErrMiss`), `src/cache/cache.js`
  + `src/cache/backoff.js` (exponential backoff with jitter).
- **Auth** — `src/auth/token.js` (HS256 JWT, `full`/`2fa_challenge` kinds),
  `src/auth/password.js` (bcrypt cost 10), `src/auth/totp.js` (otplib).
- **Payments** — `src/payment/gateway.js` (Stripe-shaped stub: idempotent,
  `simulate=network|decline|hold`), `src/payment/payment.service.js`
  (charge/refund flows, session replay across restarts).
- **Email outbox** — `src/email/sql.js` SQL consts + claim→relay→deliver
  worker with transient retry/backoff and permanent-fail admin alerts.

`Express 4` async handlers are wrapped by a small `guard()` so a rejected promise
becomes a proper error envelope instead of a hanging request.

## Environment

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|---|---|---|
| `HTTP_ADDR` | `:8080` | listen address, Go-style (`:8080` = all interfaces) |
| `DATABASE_URL` | `postgres://shop:shop@localhost:5432/shop?sslmode=disable` | Postgres DSN |
| `REDIS_ADDR` | `localhost:6379` | Redis host:port |
| `REDIS_PASSWORD` | *(empty)* | Redis auth (no default) |
| `JWT_SECRET` | `dev-secret-change-me` | HS256 signing secret |
| `JWT_TTL_MINUTES` | `60` | full-token expiry |
| `JWT_CHALLENGE_TTL_MINUTES` | `5` | 2FA challenge-token expiry |
| `TOTP_ISSUER` | `GoShop` | otpauth URL issuer |
| `MAX_PAYMENT_ATTEMPTS` | `4` | payment retry cap |
| `PAYMENT_RETRY_BASE_DELAY_MS` | `100` | payment backoff base |
| `EMAIL_WORKER_MAX_ATTEMPTS` | `5` | outbox retry cap |
| `EMAIL_WORKER_BASE_DELAY_MS` | `100` | outbox backoff base |

Floating values are rejected (digits only, like Go's `getenvInt`); missing
values fall back to the defaults above.

## Run

```bash
npm install
cp .env.example .env
npm run migrate          # apply src/db/migrations/*.sql
npm start                # server — auto-migrates + seeds on boot
npm run worker:email     # optional outbox worker (2 workers by default)
npm test                 # full in-memory suite — no DB/Redis needed
```

On boot the server runs migrations and seeds idempotently:

- **admin** / `admin@example.test` / password `ChangeMe123!` (is_admin)
- **customer** / `customer@example.test` / password `ChangeMe123!`
- 5 demo products (mouse, keyboard, monitor, dock, webcam)

## Tests

`npm test` — `node --test` over `test/`. Two flavours:

- **Route suites** (`test/<group>/*.handlers.test.js`): each mounts an Express
  app exactly like `src/app.js` does, backed by `test/db/pgmem.js` — an
  in-memory pool that matches SQL **text exactly** and scripts ordered
  expectations (the `pgxmock` equivalent). Handlers, auth, idempotency, JSON
  shapes and status codes are exercised end-to-end over real HTTP.
- **Seam suites** (`test/email/`, `test/http.js`, `test/db/pgmem.js`): worker
  claim→deliver→fail flow with pinned backoff, HTTP helpers, pool impl.

## Deliberate divergences from GoLang

- **Migration runner**: Node applies `src/db/migrations/*.sql` in lexical order
  inside per-file transactions and records them in `schema_migrations`; GoLang
  embeds a single file at startup. Same tables, same result.
- **Outbox tables**: Node's migration defines `email_messages` and
  `admin_notices`; GoLang referenced them in SQL constants but never defined
  them. Node adds them so the worker actually runs.
- **Email relay**: the production/shape relay is a console log + success (no SMTP
  dependency). GoLang ships only the relay interface + stub, so this is a dev
  seam to be swapped for a real transport.
- **No Docker/Make**: infra files from the GoLang repo are not ported.

## Layout

```
src/
  config.js          env seams (getstr/getnum, digit-only validation)
  app.js             NewRouter — mirrors internal/api/api.go (all groups)
  server.js          HTTP server — mirrors cmd/server/main.go
  seed.js            idempotent demo accounts + products — mirrors seed.go
  auth/              token.js (JWT HS256) · password.js (bcrypt · 10) · totp.js
  cache/             backoff.js · cache.js (retry) · redis.js (ioredis seam)
  cart/  product/  customer/  order/  payment/  shipping/
                     handlers (routes + guard()) + domain services
  db/                pool.js (LeanPool/Tx) · migrate.js · migrations/001_init.sql
  email/             sql.js (outbox consts) · email.service.js (worker) · worker.js (CLI)
  httpx/             respond.js · auth.js · idempotency.js
test/
  db/pgmem.js        in-memory pool (exact-SQL matching, ordered expectations)
  http.js            HTTP test helpers
  <group>/           *.handlers.test.js per route group
  email/             outbox worker test
```

## Contract source of truth

Route literals, outbox SQL, the backoff formula, idempotency TTLs, Redis keys,
envelope shapes and messages were captured verbatim from the GoLang repository
(`internal/…` files) and mirrored 1:1. See `ROUTES.md` for the per-endpoint
breakdown and `git log` for the port history (one commit + push per group).