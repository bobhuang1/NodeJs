"use strict";
/* Email outbox SQL consts — VERBATIM from GoLang internal/email/service.go
 * (email outbox section). Matched text-exact by the test seam. */
module.exports = {
  claimSQL: `SELECT id::text, to_address, subject, body, idempotency_key, attempts
FROM email_messages
WHERE status = 'pending'
  AND (attempts = 0 OR next_attempt_at <= now())
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1`,

  bumpSQL: `UPDATE email_messages
SET attempts = attempts + 1,
    next_attempt_at = now() + make_interval(secs => $2::double precision / 1000.0),
    failure_reason = $3,
    updated_at = now()
WHERE id = $1::uuid AND status = 'pending'`,

  deliveredSQL: `UPDATE email_messages
SET status = 'delivered', sent_at = now(), updated_at = now()
WHERE id = $1::uuid AND status = 'pending'`,

  failSQL: `UPDATE email_messages
SET status = 'failed', failure_reason = $2, updated_at = now()
WHERE id = $1::uuid AND status = 'pending'`,

  alertSQL: `INSERT INTO admin_notices (kind, title, body, status)
VALUES ('email_failed', $1, $2, 'new')`,
};
