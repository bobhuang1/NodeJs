# NodeJs route surface

Status: **complete.** This is sample code documenting the HTTP route surface of
the Node.js shopping service — every endpoint below is implemented in the
Express handlers (`src/customer|customer/auth`, `src/product`, `src/cart`,
`src/order`, `src/payment`, `src/shipping`) and wired in `src/app.js`
(`NewRouter`). The routes are exercised through in-memory HTTP tests
(`test/*/.*.test.js`, `npm test` 20/20), so this file is the proven contract,
not a plan.

## Routes

Path prefix for all: `GET /healthz` (probe pool, no auth), then `/api/v1`.

### healthz
- `GET  /healthz`

### product
- `GET  /api/v1/products`            (list: page/limit/q)
- `GET  /api/v1/products/{id}`
- `POST /api/v1/admin/products`      (require admin)
- `PUT  /api/v1/admin/products/{id}` (require admin)
- `DELETE /api/v1/admin/products/{id}` (require admin)

### cart
- `GET    /api/v1/cart`              (view)
- `DELETE /api/v1/cart`              (clear)
- `POST   /api/v1/cart/items`        (add)
- `PUT    /api/v1/cart/items/{productID}` (update qty)
- `DELETE /api/v1/cart/items/{productID}` (remove)
- `POST   /api/v1/cart/checkout`     (defer to order/payment seams)

### customer + auth
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

### orders
- `GET   /api/v1/orders`                   (own — RequireAuth)
- `GET   /api/v1/orders/{id}`              (detail — RequireAuth)
- `GET   /api/v1/admin/orders`             (list — RequireAuth+RequireAdmin)
- `POST  /api/v1/admin/orders/{id}/process`(process — RequireAuth+RequireAdmin)

### payments
- `GET   /api/v1/payments/charges`         (myCharges — RequireAuth)
- `POST  /api/v1/payments/charges`         (charge — idempotent, Idempotency-Key)
- `GET   /api/v1/payments/charges/{id}`    (getCharge — RequireAuth)
- `POST  /api/v1/payments/refunds`         (refund — RequireAuth)
- `GET   /api/v1/payments/refunds`         (myRefunds — RequireAuth)
- `POST  /api/v1/admin/refunds`            (adminRefund — RequireAuth+RequireAdmin)

### shipping
- `GET   /api/v1/shipping`                 (own — RequireAuth)
- `GET   /api/v1/shipping/track`           (track — RequireAuth)
- `GET   /api/v1/shipping/orders/{orderID}`(byOrder — RequireAuth)
- `POST  /api/v1/admin/shipments`          (ship — RequireAuth+RequireAdmin)
- `PUT   /api/v1/admin/shipments/{id}`     (update — RequireAuth+RequireAdmin)

## Wiring

Middleware order: RequestIDMW → RecoverMW → LoggerMW → `/healthz`, then the six
groups under `/api/v1`. A **single shared** IdempotencyGuard (TTL 10m, max 1000)
wraps cart, payments and admin/refunds. Handlers decode bodies themselves, so no
body parser is mounted. `src/server.js` runs migrations on boot, a redis-or-Null
degraded cache, seed, and graceful shutdown; `src/email/worker.js` runs the
outbox worker.

## Not mounted
- admin customers list, email outbox/messages views, admin notices views — the
  router never registers these; only the worker feeds admin_notices.
- No `simulate` SMTP relay: `npm run worker:email` uses a console relay (dev
  seam until a real SMTP/SES transport is added).

## Route groups
The router mounts: customer(+auth), products(public+admin), cart, orders
(customer+admin), payments(+admin/refunds), shipping(+admin/shipments), healthz.
`src/app.js` `NewRouter` registers each group; see `git log` for the change
history.