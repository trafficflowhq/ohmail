-- THE BLIND-SAFE CARRIER FOR THE DEVICE-SYNC STALENESS ALERT.
--
-- ══ WHAT THIS FIXES ════════════════════════════════════════════════════════════════════════
--
-- The `device_sync_stale` rule (mail 0064's column, `alerts.ts` rule 8) read `devices`,
-- `sessions` and `change_log` directly — and the alert pass runs on the CONTENT-BLIND staff
-- handle, which has no grant on the first two and deliberately forbids the third
-- (`staff-grants.ts`: row existence in `change_log` is itself information). PostgreSQL checks
-- privileges before matching rows, so the whole evaluation answered 42501 and every OTHER
-- alert died with it: the pager was dark precisely because a new alarm had been added to it.
--
-- ══ THE FUNCTION ═══════════════════════════════════════════════════════════════════════════
--
-- SECURITY DEFINER, owned by the migration role, returning ONLY closed fields — a device id,
-- its kind, its stamp, and the wall-clock of the account's newest change. No token, no address,
-- no label (user-chosen text), no message anything. The three predicates live inside it, so the
-- caller cannot widen the projection:
--
--   · kind <> 'web'                — a browser tab left closed is not an incident;
--   · stamp older than the cutoff  — with a NULL stamp excluded: never-synced asserts nothing;
--   · the account MOVED ON         — its newest change_log row is younger than the stamp;
--   · still ARMED                  — an unrevoked session, or one revoked after `arm_after`
--                                    (reuse detection revokes silently; the person in front of
--                                    the mirror does not know).
--
-- `SET search_path = public, pg_temp` pins resolution: a definer function that trusts the
-- caller's search_path is an escalation door. EXECUTE is REVOKED from PUBLIC (functions default
-- to PUBLIC-executable, which would hand this projection to every role the pooler can mint) and
-- granted to the blind staff role alone, only where that role exists — a local engine's PGlite
-- and a self-host database have no such role and no alert pass either.
--
-- ══ ADDITIVE, IDEMPOTENT, NO DATA ══════════════════════════════════════════════════════════
--
-- CREATE OR REPLACE + re-runnable REVOKE/GRANT. Deploy order: migration → API (the rule's
-- caller tolerates a missing function by skipping this one rule, never the pass).
-- ROLLBACK is `DROP FUNCTION device_sync_stale_candidates(timestamptz, timestamptz)`; the cost
-- is the alert going blind again.

CREATE OR REPLACE FUNCTION "device_sync_stale_candidates"(stale_before timestamp with time zone, arm_after timestamp with time zone)
RETURNS TABLE (device_id uuid, kind text, last_synced_at timestamp with time zone, newest_change_at timestamp with time zone)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT d.id, d.kind, d.last_synced_at, latest.created_at
  FROM devices d
  CROSS JOIN LATERAL (
    SELECT c.created_at FROM change_log c
    WHERE c.account_id = d.account_id
    ORDER BY c.seq DESC LIMIT 1
  ) latest
  WHERE d.kind <> 'web'
    AND d.last_synced_at IS NOT NULL
    AND d.last_synced_at < stale_before
    AND latest.created_at > d.last_synced_at
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.device_id = d.id
        AND (s.revoked_at IS NULL OR s.revoked_at > arm_after)
    )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "device_sync_stale_candidates"(timestamp with time zone, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ohmail_admin') THEN
    GRANT EXECUTE ON FUNCTION "device_sync_stale_candidates"(timestamp with time zone, timestamp with time zone) TO "ohmail_admin";
  END IF;
END $$;
