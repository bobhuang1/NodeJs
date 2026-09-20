"use strict";
/* Demo seed — NodeJs port of cmd/server/seed.go. Idempotent: existing rows are
 * left untouched (ON CONFLICT DO NOTHING for accounts; duplicate SKUs are
 * skipped and logged like Go's slog.Debug). */
const { HashPassword } = require("./auth/password.js");

const demoProducts = [
  { sku: "MOUSE-001", name: "Wireless Mouse", description: "Silent click, 2.4 GHz", price: 2499, stock: 50 },
  { sku: "KB-001", name: "Mechanical Keyboard", description: "65% layout, hot-swap", price: 8999, stock: 30 },
  { sku: "MON-001", name: "27in 4K Monitor", description: "IPS, 95% DCI-P3", price: 39999, stock: 20 },
  { sku: "DOCK-001", name: "USB-C Hub", description: "8-in-1, 100W PD", price: 5499, stock: 100 },
  { sku: "CAM-001", name: "Webcam 1080p", description: "Autofocus, dual mic", price: 7999, stock: 40 },
];

async function seed(pool, products) {
  const adminHash = await HashPassword("ChangeMe123!");
  await pool.exec(
    `INSERT INTO customers (email, password_hash, full_name, is_admin)
     VALUES ('admin@example.test', $1, 'Demo Admin', TRUE)
     ON CONFLICT (email) DO NOTHING`,
    [adminHash]
  );

  const custHash = await HashPassword("ChangeMe123!");
  await pool.exec(
    `INSERT INTO customers (email, password_hash, full_name)
     VALUES ('customer@example.test', $1, 'Demo Customer')
     ON CONFLICT (email) DO NOTHING`,
    [custHash]
  );
  console.log("seeded demo accounts", "admin", "admin@example.test", "customer", "customer@example.test", "password", "ChangeMe123!");

  let count = 0;
  for (const p of demoProducts) {
    try {
      await products.create(p.sku, p.name, p.description, "usd", p.price, p.stock);
      count += 1;
    } catch (err) {
      // Duplicate SKU on re-seed is fine (Go: slog.Debug skip).
      console.debug("product already seeded (skipping)", p.sku);
    }
  }
  console.log("seeded demo products", "count", count);

  return { admin: "admin@example.test", customer: "customer@example.test", password: "ChangeMe123!" };
}

module.exports = { seed, demoProducts };