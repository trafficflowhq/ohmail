-- RETIRE `device_sync_stale_candidates` — mail 0067's carrier, withdrawn the same night.
--
-- 0067 built the device-sync staleness alert's read as a SECURITY DEFINER function granted to
-- the content-blind staff role. The staff-role attestation refuses that BY CONSTRUCTION: its
-- census names "EXECUTE on a SECURITY DEFINER routine" as a hole straight through every column
-- grant, with an allowlist that is empty on purpose, and the provisioner's pre-flight aborts
-- while any such routine exists in public/admin at all. Measured live: the function's grant
-- refused the staff brand on every alert pass — the pager went dark BECAUSE an alarm was added
-- to it, which is the exact failure the attestation exists to make loud.
--
-- The alert now reads plain COLUMN grants instead (`devices` id/account_id/kind/last_synced_at,
-- `sessions` device_id/revoked_at — provisioned from the staff allowlist, the designed widening
-- mechanism), and the "account moved on" gate reads `mailboxes.last_sync_at`, which the role
-- already held. No secdef remains.
--
-- Idempotent; a database that never applied 0067 drops nothing. ROLLBACK is re-running 0067's
-- CREATE — and the provisioner refusing again, which is the point.

DROP FUNCTION IF EXISTS "device_sync_stale_candidates"(timestamp with time zone, timestamp with time zone);
