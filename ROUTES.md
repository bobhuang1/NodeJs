# NodeJs route surface — NodeJs✓ port of GoLang api router

Status: **partial, honest.** Every literal below was **read verbatim from the
GoLang repo files** (not recalled, not invented). Routes NOT listed are not yet
ported. This file is the seam that will grow as each handler lands; nothing here
is fabricated.

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

## Remaining surface (thin, honest remainder)
- full 40-body handler logic per endpoint (goes through the already-green seams:
  httpx, customer/auth, cache/backoff+retry, db/pool/migrate, email outbox worker)
- admin: customers list, email outbox/messages, admin notices views
- auth guard bodies: JWT HS256 verify + TOTP (otplib) + bcrypt seam wiring

## Gap-log (what "40 routes" means, from GoLang api wiring seen so far)
GoLang `api.go` mounts: customer, products(public+admin), cart, orders(customer+
admin), payments(+admin/refunds), shipping(+admin/shipments), healthz. The NodeJs
port must reproduce each route literal 1:1 — the crux worker
(`src/email/email.service.js`) already proves the outbox seam those routes feed.
