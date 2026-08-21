-- 0061_web_sessions_deviceless — plain browser sign-ins stop owning device rows (DEVICES).
--
-- `establish` used to mint a `devices` row labeled "Web" for EVERY browser sign-in, so the
-- table that exists to make a PAIRED device visible and takable-back grew one indistinguishable
-- row per sign-in — hundreds on a well-used account, and a Devices pane that buried the named
-- devices under them. The code now mints device rows for NAMED devices only (a pairing redeem's
-- labeled mint, the desktop's "ohmail for Mac" claim), and `device_id IS NULL` means the same
-- thing on every tier: a session that is not a named device — the discriminator the sidecar's
-- launch session established (`apps/sidecar/src/identity.ts`). This migration makes history
-- match: sessions pointing at an auto-minted "Web" row become device-less, and the orphaned
-- rows leave.
--
-- A DATA migration, deliberately and narrowly — the exception 0021's dedup prelude carved, not
-- a precedent loosened. What the two statements can and cannot do:
--
--  · The UPDATE revokes NOTHING and touches no credential: `device_id` is display/aim-scoping
--    metadata, and every session keeps its tokens, its family and its lifetime. (Contrast the
--    refusal 0060 states for `UPDATE refresh_tokens SET revoked_at` — a mass sign-out hiding
--    in a schema change. Nothing here moves a lifecycle column.)
--  · The discriminator is STRUCTURAL twice over. `kind='web' AND label='Web'` names the
--    auto-mint literal (a pairing mint's label is the minter's word, with 'Paired device' as
--    its non-empty fallback — never ''), and the interval conjunct is the surface's own
--    arithmetic: `establish` and `mintRotation` write `last_seen_at` and `refresh_expires_at`
--    in lockstep, so their difference IS the mint surface's window — 90 days for the browser
--    cookie jar, 400 for a paired device's native bearer. A paired web-kind device somebody
--    deliberately labeled "Web" therefore stays a device (400d > 100d), and only true
--    cookie-surface sessions (90d < 100d) are detached.
--  · The DELETE takes only rows the UPDATE (or history) left unreferenced — NOT EXISTS over
--    `sessions.device_id`, with the FK (no ON DELETE) as the second fence — so any row still
--    referenced by a session the conjunct excluded survives.
--  · Both statements are IDEMPOTENT: a re-run matches nothing. That is load-bearing for the
--    deploy: the journal applies this once, and the runbook re-runs the same two statements by
--    hand AFTER the new code is aliased live, sweeping the rows the old code minted in the
--    window between migration and alias.
--
-- Desktop-tier stores match zero rows (launch sessions never had device rows; paired mints are
-- labeled). Hosted and self-host stores are where the flood lived.
UPDATE "sessions"
   SET "device_id" = NULL
 WHERE "device_id" IN (SELECT "id" FROM "devices" WHERE "kind" = 'web' AND "label" = 'Web')
   AND ("refresh_expires_at" - "last_seen_at") < INTERVAL '100 days';
--> statement-breakpoint
DELETE FROM "devices" d
 WHERE d."kind" = 'web' AND d."label" = 'Web'
   AND NOT EXISTS (SELECT 1 FROM "sessions" s WHERE s."device_id" = d."id");
