"use strict";
/* password seam — NodeJs port of GoLang internal/auth/password.go (bcrypt,
 * DefaultCost = 10). bcryptjs stands in for golang.org/x/crypto/bcrypt. */
const bcrypt = require("bcryptjs");

const BcryptCost = 10; // bcrypt.DefaultCost

// HashPassword bcrypt-encodes a plaintext password (Go: GenerateFromPassword).
async function HashPassword(plain) {
  return bcrypt.hash(plain, BcryptCost);
}

// CheckPassword reports whether plain matches the stored hash.
function CheckPassword(hash, plain) {
  return bcrypt.compareSync(plain, hash);
}

module.exports = { HashPassword, CheckPassword, BcryptCost };