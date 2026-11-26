CREATE TABLE IF NOT EXISTS "worker_topology" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  "shards" integer NOT NULL CHECK (shards > 0)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION initialize_worker_topology(expected_shards integer DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  existing integer;
  inferred integer;
  total integer;
  matching integer;
  occupied boolean;
BEGIN
  SELECT shards INTO existing FROM public.worker_topology WHERE singleton;
  IF FOUND THEN
    IF expected_shards IS NULL OR expected_shards = existing THEN RETURN existing; END IF;
    RETURN NULL;
  END IF;

  -- The legacy worker's session lock identifies currently serving indices. A heartbeat
  -- by itself can outlive a process, and a lock without a fresh matching heartbeat
  -- cannot establish a width. Require a complete roster before publishing anything.
  WITH locked AS (
    SELECT (objid::bigint - 4207270001)::integer AS shard_index, pid
    FROM pg_locks
    WHERE locktype = 'advisory' AND granted AND mode = 'ExclusiveLock'
      AND classid = 0 AND objsubid = 1 AND objid::bigint BETWEEN 4207270001 AND 4207280000
      -- The API clock, migration and first-run setup keys overlap the numeric range.
      AND objid::bigint NOT IN (4207278001, 4207279001, 4207279101)
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
  ), roster AS (
    SELECT h.shards, locked.shard_index
    FROM locked LEFT JOIN public.worker_heartbeats h USING (shard_index)
    LEFT JOIN pg_stat_activity a ON a.pid = locked.pid
    WHERE h.leader AND h.beat_at >= greatest(a.backend_start, now() - interval '2 minutes')
      AND locked.shard_index < h.shards
  )
  SELECT (SELECT count(*) FROM locked), count(*),
    CASE WHEN min(shards) = max(shards) THEN min(shards) END
  INTO total, matching, inferred FROM roster;

  IF total = 0 THEN
    -- Heartbeats retain the configured width after a drain, even if only part of
    -- the roster wrote a heartbeat. Each recorded index must be valid for that width.
    SELECT count(*), CASE WHEN min(shards) = max(shards)
      AND bool_and(shards BETWEEN 1 AND 9999 AND shard_index BETWEEN 0 AND shards - 1)
      THEN min(shards) END
    INTO total, inferred FROM public.worker_heartbeats;
    IF total = 0 THEN
      occupied := false;
      IF expected_shards IS NOT NULL AND to_regclass('public.mailboxes') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT FROM public.mailboxes)' INTO occupied;
      END IF;
      IF NOT occupied THEN inferred := 1; END IF;
    ELSIF inferred IS NULL THEN
      -- Only the migration owner may supply a verified width for a conflicting
      -- stopped roster. Live workers always use the lock and heartbeat checks.
      IF expected_shards BETWEEN 1 AND 9999 THEN inferred := expected_shards; END IF;
    ELSIF expected_shards IS NOT NULL AND total <> inferred THEN
      RETURN NULL;
    END IF;
  ELSIF total <> inferred OR matching <> inferred THEN
    RETURN NULL;
  END IF;
  IF inferred IS NULL
    OR (expected_shards IS NOT NULL AND expected_shards <> inferred) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.worker_topology (shards) VALUES (inferred) ON CONFLICT (singleton) DO NOTHING;
  SELECT shards INTO existing FROM public.worker_topology WHERE singleton;
  IF existing = inferred THEN RETURN existing; END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION initialize_worker_topology(integer) FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  configured text := nullif(current_setting('ohmail.worker_shards', true), '');
BEGIN
  IF configured IS NOT NULL AND configured !~ '^[1-9][0-9]{0,3}$' THEN
    RAISE EXCEPTION 'ohmail.worker_shards must be a verified worker width from 1 to 9999';
  END IF;
  IF public.initialize_worker_topology(configured::integer) IS NULL THEN
    RAISE EXCEPTION 'Cannot verify worker topology. Drain the workers and verify their configured width before setting ohmail.worker_shards for this migration.';
  END IF;
END
$$;

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ohmail_api') THEN
    REVOKE ALL ON worker_topology FROM ohmail_api;
    GRANT SELECT ON worker_topology TO ohmail_api;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'ohmail_worker') THEN
    REVOKE ALL ON worker_topology FROM ohmail_worker;
    GRANT SELECT ON worker_topology TO ohmail_worker;
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION change_worker_topology(expected_shards integer, next_shards integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF next_shards IS NULL OR next_shards NOT BETWEEN 1 AND 9999 OR NOT pg_try_advisory_xact_lock(420727, 1) THEN
    RETURN false;
  END IF;
  IF next_shards <> expected_shards THEN
    -- This transaction cannot hand off a running shard. The empty-store check and
    -- width write share a table lock with mailbox admission.
    LOCK TABLE public.mailboxes IN SHARE MODE NOWAIT;
    IF EXISTS (SELECT FROM public.mailboxes) THEN RETURN false; END IF;
  END IF;
  UPDATE public.worker_topology SET shards = next_shards
  WHERE singleton AND shards = expected_shards;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  -- Retire old fences together with the width. A successor may have a different shard index.
  IF next_shards <> expected_shards THEN
    UPDATE public.worker_heartbeats SET leader = false WHERE leader = true;
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION change_worker_topology(integer, integer) FROM PUBLIC;
