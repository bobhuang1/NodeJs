"use strict";
/* product domain — NodeJs port of GoLang internal/product/product.go VERBATIM:
 * SQL text, validation messages, JSON shapes, 60s read-through cache TTL, the
 * cacheKey prefix, and the FOR UPDATE ReserveStock used by the cart checkout.
 * Redis failures degrade to PostgreSQL instead of failing the request. */
const { BadRequest, Conflict, NotFound, Wrap } = require("../httpx/respond.js");
const { ErrMiss, isMiss } = require("../cache/redis.js");

const cacheTTL = 60 * 1000; // NewService: cacheTTL = 60 * time.Second

function cacheKey(id) {
  return "product:" + id;
}

class Service {
  constructor(pool, cache) {
    this.pool = pool;
    this.cache = cache;
  }

  // Create adds a product and (best-effort) publishes the cache.
  async create(sku, name, description, currency, priceCents, stock) {
    if (sku === "" || name === "" || priceCents < 0 || stock < 0) {
      throw BadRequest("sku, name, non-negative price and stock are required");
    }
    if (currency === "") currency = "usd";
    let row;
    try {
      row = await this.pool.queryRow(
        `INSERT INTO products (sku, name, description, price_cents, currency, stock)
        VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, sku, name, description, price_cents, currency, stock, active, created_at`,
        [sku, name, description, priceCents, currency, stock]
      );
    } catch (err) {
      if (err && err.code === "23505") throw Conflict("sku already exists");
      throw Wrap(err);
    }
    const p = mapProduct(row);
    await this.cacheSet(p);
    return p;
  }

  // Get reads a product through the cache: hit -> JSON, miss -> DB + backfill.
  async get(id) {
    try {
      const raw = await this.cache.get(cacheKey(id));
      try {
        return JSON.parse(raw.toString("utf8"));
      } catch (e) {
        // corrupt/invalid JSON cached value: fall through to the DB.
      }
    } catch (err) {
      if (!isMiss(err)) {
        console.warn("product cache read degraded to postgres", { product_id: id, err: String(err) });
      }
    }

    let row;
    try {
      row = await this.pool.queryRow(
        `SELECT id, sku, name, description, price_cents, currency, stock, active, created_at
        FROM products WHERE id = $1 AND active = TRUE`,
        [id]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (!row) throw NotFound("product not found");
    const p = mapProduct(row);
    await this.cacheSet(p);
    return p;
  }

  // List returns active products with basic pagination.
  async list(page, limit, q) {
    if (page < 1) page = 1;
    if (limit < 1 || limit > 100) limit = 20;
    const offset = (page - 1) * limit;
    let res;
    try {
      res = await this.pool.query(
        `SELECT id, sku, name, description, price_cents, currency, stock, active, created_at
        FROM products
        WHERE active = TRUE AND ($3 = '' OR name ILIKE $3 OR sku ILIKE $3 OR description ILIKE $3)
        ORDER BY id
        LIMIT $1 OFFSET $2`,
        [limit, offset, likePattern(q)]
      );
    } catch (err) {
      throw Wrap(err);
    }
    return res.rows.map(mapProduct);
  }

  // Update modifies a product and invalidates its cache entry.
  async update(id, in_) {
    let tag;
    try {
      tag = await this.pool.exec(
        `UPDATE products SET
            sku            = COALESCE(NULLIF($2, ''), sku),
            name           = COALESCE(NULLIF($3, ''), name),
            description    = COALESCE($4, description),
            price_cents    = COALESCE($5, price_cents),
            currency       = COALESCE(NULLIF($6, ''), currency),
            stock          = COALESCE($7, stock),
            updated_at     = now()
        WHERE id = $1`,
        [id, in_.sku, in_.name, in_.description ?? null, in_.price_cents ?? null, in_.currency, in_.stock ?? null]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (tag.rowCount === 0) throw NotFound("product not found");
    // Best-effort cache invalidation; failure only leaves a stale TTL window.
    try {
      await this.cache.del(cacheKey(id));
    } catch (err) {
      console.warn("product cache invalidation degraded", { product_id: id, err: String(err) });
    }
    return this.get(id);
  }

  // Deactivate soft-deletes a product (active = FALSE) and invalidates cache.
  async deactivate(id) {
    let tag;
    try {
      tag = await this.pool.exec(
        `UPDATE products SET active = FALSE, updated_at = now() WHERE id = $1`,
        [id]
      );
    } catch (err) {
      throw Wrap(err);
    }
    if (tag.rowCount === 0) throw NotFound("product not found");
    try {
      await this.cache.del(cacheKey(id));
    } catch (err) {
      console.warn("product cache invalidation degraded", { product_id: id, err: String(err) });
    }
  }

  // reserveStock decrements stock inside the caller's transaction (Go package
  // function product.ReserveStock). The FOR UPDATE row lock plus the DB CHECK
  // (stock >= 0) serialise concurrent checkout attempts.
  async reserveStock(tx, productID, qty) {
    return reserveStockCore(tx, productID, qty);
  }

  async cacheSet(p) {
    const raw = JSON.stringify(p);
    try {
      await this.cache.set(cacheKey(p.id), raw, cacheTTL);
    } catch (err) {
      console.warn("product cache write degraded", { product_id: p.id, err: String(err) });
    }
  }
}

// ReserveStock — package function equivalent (Go: product.ReserveStock).
async function ReserveStock(tx, productID, qty) {
  return reserveStockCore(tx, productID, qty);
}

async function reserveStockCore(tx, productID, qty) {
  let p;
  try {
    p = await tx.queryRow(
      `SELECT id, sku, name, price_cents, currency, stock, active
      FROM products WHERE id = $1 FOR UPDATE`,
      [productID]
    );
  } catch (err) {
    throw Wrap(err);
  }
  if (!p) throw NotFound("product not found");
  if (!p.active) throw Conflict("product is no longer active");
  if (p.stock < qty) {
    throw Conflict(`insufficient stock for ${p.name} (have ${p.stock}, want ${qty})`);
  }
  await tx.exec(
    `UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1`,
    [productID, qty]
  );
  p.stock -= qty;
  return mapReserved(p);
}

function mapProduct(r) {
  return {
    id: Number(r.id),
    sku: r.sku,
    name: r.name,
    description: r.description,
    price_cents: Number(r.price_cents),
    currency: r.currency,
    stock: Number(r.stock),
    active: r.active,
    created_at: r.created_at,
  };
}

// mapReserved mirrors the ReserveStock scan (no description/created_at).
function mapReserved(r) {
  return {
    id: Number(r.id),
    sku: r.sku,
    name: r.name,
    price_cents: Number(r.price_cents),
    currency: r.currency,
    stock: Number(r.stock),
    active: r.active,
  };
}

function likePattern(q) {
  if (q === undefined || q === "") return "";
  return "%" + q + "%";
}

module.exports = { Service, ReserveStock, cacheKey, cacheTTL, likePattern, mapProduct, mapReserved };