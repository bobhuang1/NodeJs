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

## Remaining surface (NOT yet ported — read+port per file, one handler at a time)
customer (register/login/2fa/forgot/reset), orders (create/get/list/cancel +
tracking), payments (charge/refund, idempotent), shipping (rates/labels/track),
admin (orders list, customers list, email outbox), auth guard (JWT/TOTP/bcrypt).

## Gap-log (what "40 routes" means, from GoLang api wiring seen so far)
GoLang `api.go` mounts: customer, products(public+admin), cart, orders(customer+
admin), payments(+admin/refunds), shipping(+admin/shipments), healthz. The NodeJs
port must reproduce each route literal 1:1 — the crux worker
(`src/email/email.service.js`) already proves the outbox seam those routes feed.
