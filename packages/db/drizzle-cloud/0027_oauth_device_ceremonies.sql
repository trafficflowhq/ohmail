-- THE DEVICE-CODE CEREMONY GETS ITS OWN TABLE — the self-host door's in-flight state.
--
-- ══ WHY NOT COLUMNS ON `mailbox_oauth_ceremonies` ══════════════════════════════════════════
--
-- The redirect ceremony's `code_verifier_enc` is NOT NULL, and a device ceremony has no PKCE
-- verifier: the device grant has no redirect and no authorization code, so there is nothing for a
-- verifier to bind. Adding the device fields to that table would mean either dropping that NOT
-- NULL — weakening a live invariant of the redirect flow for a feature that does not use the
-- column — or writing a dummy verifier, which is a lie in the row a reader would most need to
-- trust.
--
-- The consumption disciplines are also opposites, and that is the sharper half. The redirect
-- ceremony is spent by ONE request. The device ceremony is READ REPEATEDLY — every few seconds for
-- up to fifteen minutes, while a person walks to a browser — and consumed only on a terminal
-- verdict. Two disciplines in one table is one WHERE clause away from a poll consuming the
-- ceremony it is polling for, which would present as "that code expired" to somebody who typed it
-- correctly.
--
-- ══ WHAT IS SEALED AND WHAT IS NOT ═════════════════════════════════════════════════════════
--
-- `device_code_enc` is a KEK envelope: it is the bearer credential that redeems the grant, and this
-- row is the one place a read-only injection could stand between the ceremony and somebody's
-- mailbox. `user_code` and `verification_uri` are the values the person is SHOWN, stored in clear
-- deliberately — it adds no exposure the start response did not already have, and it lets a poll
-- re-supply them after a reload; the browser keeps only the ceremony HANDLE (per tab), and the
-- poll it makes with that handle is what puts the code back on screen.
--
-- ══ ADDITIVE, IDEMPOTENT, NO DATA ══════════════════════════════════════════════════════════
--
-- One new table and one index. Nothing reads it until the device-flow routes are mounted, and those
-- are mounted only by the self-host composition, so this migration is inert on a deployment that
-- never arms a public client. Deploy order is unconstrained: the table before the routes is an
-- unused table, and the routes before the table would fail loudly on the first start rather than
-- write anything half-formed.
CREATE TABLE IF NOT EXISTS "mailbox_oauth_device_ceremonies" (
  -- 256-bit random, base64url, minted by us and NEVER the device_code: this handle travels in
  -- every poll body, and the credential must not.
  "state" text PRIMARY KEY,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id"),
  "provider" text NOT NULL,
  -- Sealed together by NOT NULL on both, so the state where a ciphertext has no key version — an
  -- envelope nothing can open — is unrepresentable rather than CHECK-guarded.
  "device_code_enc" text NOT NULL,
  "device_code_key_version" integer NOT NULL,
  "user_code" text NOT NULL,
  "verification_uri" text NOT NULL,
  -- Already includes every `slow_down` increment so far. RFC 8628 §3.5 requires the increase to be
  -- CUMULATIVE, and across a stateless poll route that arithmetic has nowhere else to live: the
  -- client id being throttled is SHARED by every install using the public registration, so one
  -- caller that reset its interval would degrade the flow for all of them.
  "poll_interval_ms" integer NOT NULL,
  "grant_expires_at" timestamptz NOT NULL,
  -- NULL before the first poll. The fence that refuses an early poll without spending a request on
  -- Microsoft to be told the same thing.
  "last_polled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Written ONLY on a terminal verdict. A pending poll leaves it NULL, which is what makes the
  -- read non-consuming; the single-use claim is
  -- `UPDATE … SET consumed_at = now() WHERE state = $1 AND consumed_at IS NULL RETURNING …`.
  "consumed_at" timestamptz
);
--> statement-breakpoint

-- Keyed by the prune, which is opportunistic on the start path rather than a cron: the whole
-- content of this table is the last hour of connect attempts.
CREATE INDEX IF NOT EXISTS "mailbox_oauth_device_ceremonies_created_idx"
  ON "mailbox_oauth_device_ceremonies" ("created_at");
