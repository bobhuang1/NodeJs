# NodeJs route surface — NodeJs✓ port of GoLang api router

Status: **complete.** Every literal below was **read verbatim from the
GoLang repo files** (not recalled, not invented) and ported 1:1 to the
Express handlers (`src/customer|customer/auth`, `src/product`,
`src/cart`, `src/order`, `src/payment`, `src/shipping`) plus the wiring in
`src/app.js` (NewRouter, mirrors `internal/api/api.go`). Route levels were
exercised through in-memory HTTP tests (`test/*/.*.test.js`, `npm test`
20/20), so this file is the proven contract, not a plan.

## Verified verbatim (read from GoLang source this session)

Path prefix for all: `GET /healthz` (probe pool, no auth), then `/api/v1`.

### healthz
- `GET  /healthz`

### product (src → GoLang `internal/product/handlers.go`)
- `GET  /api/v1/products`            (list: page/limit/q)
- `GET  /api/v1/products/{id}`
- `POST /api/v1/admin/products`      (require admin)
- `PUT  /api/v1/admin/products/{id}` (require admin)
- `DELETE /api/v1/admin/products/{id}` (require admin)

### cart (src → GoLang `internal/cart/handlers.go`)
- `GET    /api/v1/cart`              (view)
- `DELETE /api/v1/cart`              (clear)
- `POST   /api/v1/cart/items`        (add)
- `PUT    /api/v1/cart/items/{productID}` (update qty)
- `DELETE /api/v1/cart/items/{productID}` (remove)
- `POST   /api/v1/cart/checkout`     (defer to order/payment seams)

### customer + auth (verbatim from GoLang `internal/customer/handlers.go` read this session)
- `POST /api/v1/auth/login`          (login)
- `POST /api/v1/auth/login/2fa`      (login2FA: challenge_token+code → JWT)
- `POST /api/v1/auth/logout`         (logout)
- `POST /api/v1/auth/2fa/enroll`     (enroll2FA — RequireAuth: secret/otpauth_url/manual_key)
- `POST /api/v1/auth/2fa/activate`   (activate2FA — RequireAuth)
- `POST /api/v1/auth/2fa/disable`    (disable2FA — RequireAuth)
- `POST /api/v1/customers`           (register: email/password/full_name → customer+JWT)
- `POST /api/v1/customers/forgot-password` (forgotPassword)
- `POST /api/v1/customers/reset-password`  (resetPassword)
- `GET   /api/v1/customers/me`       (me — RequireAuth)
- `GET   /api/v1/customers/{id}`     (get — RequireAuth + requireOwnOrAdmin)
- `PUT   /api/v1/customers/{id}`     (update: full_name — RequireAuth + requireOwnOrAdmin)
- `DELETE /api/v1/customers/{id}`    (delete — RequireAuth + requireOwnOrAdmin)

### orders (verbatim GoLang `internal/order/handlers.go` — read this session)
- `GET   /api/v1/orders`                   (own — RequireAuth)
- `GET   /api/v1/orders/{id}`              (detail — RequireAuth)
- `GET   /api/v1/admin/orders`             (list — RequireAuth+RequireAdmin)
- `POST  /api/v1/admin/orders/{id}/process`(process — RequireAuth+RequireAdmin)

### payments (verbatim GoLang `internal/payment/handlers.go` — read this session)
- `GET   /api/v1/payments/charges`         (myCharges — RequireAuth)
- `POST  /api/v1/payments/charges`         (charge — idempotent, Idempotency-Key)
- `GET   /api/v1/payments/charges/{id}`    (getCharge — RequireAuth)
- `POST  /api/v1/payments/refunds`         (refund — RequireAuth)
- `GET   /api/v1/payments/refunds`         (myRefunds — RequireAuth)
- `POST  /api/v1/admin/refunds`            (adminRefund — RequireAuth+RequireAdmin)

### shipping (verbatim GoLang `internal/shipping/handlers.go` — read this session)
- `GET   /api/v1/shipping`                 (own — RequireAuth)
- `GET   /api/v1/shipping/track`           (track — RequireAuth)
- `GET   /api/v1/shipping/orders/{orderID}`(byOrder — RequireAuth)
- `POST  /api/v1/admin/shipments`          (ship — RequireAuth+RequireAdmin)
- `PUT   /api/v1/admin/shipments/{id}`     (update — RequireAuth+RequireAdmin)

## Wiring now 1:1 (src/app.js NewRouter, mirrors api.go)
Middleware order: RequestIDMW → RecoverMW → LoggerMW → `/healthz`, then the six
groups under `/api/v1`. A **single shared** IdempotencyGuard (TTL 10m, max 1000)
wraps cart, payments and admin/refunds exactly like api.go. Handlers decode
bodies themselves, so no body parser is mounted. `src/server.js` mirrors
`cmd/server/main.go` (migrations on boot, redis-or-Null degraded cache, seed,
graceful shutdown); `src/email/worker.js` mirrors `internal/email Service.Run`.

## Not mounted (and not in GoLang api.go either)
- admin customers list, email outbox/messages views, admin notices views — the
  GoLang router never registers these; only the worker feeds admin_notices.
- No `simulate` SMTP relay: `npm run worker:email` uses a console relay (dev
  seam until a real SMTP/SES transport is added).

## Route groups (from GoLang api wiring)
GoLang `api.go` mounts: customer(+auth), products(public+admin), cart, orders
(customer+admin), payments(+admin/refunds), shipping(+admin/shipments), healthz.
`src/app.js` NewRouter reproduces each mount 1:1 (one commit per group, pushed
as `3278f5e`→`cb5769c`→`d5dc938`→`4538d31`→`c80e0aa`→`e15ece6`; wiring commit
follows).
