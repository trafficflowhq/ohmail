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

  IF total = 0 AND NOT EXISTS (SELECT FROM public.worker_heartbeats) THEN
    occupied := false;
    IF to_regclass('public.mailboxes') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT FROM public.mailboxes)' INTO occupied;
    END IF;
    IF NOT occupied THEN inferred := 1; total := 1; matching := 1; END IF;
  END IF;
  IF total = 0 AND expected_shards BETWEEN 1 AND 9999 THEN
    -- A stopped legacy fleet needs an explicitly verified configuration and a full
    -- consistent roster in its last heartbeats.
    SELECT count(*), count(*) FILTER (
      WHERE shards = expected_shards AND shard_index BETWEEN 0 AND expected_shards - 1
    ) INTO total, matching FROM public.worker_heartbeats;
    IF total = expected_shards THEN inferred := expected_shards; END IF;
  END IF;
  IF inferred IS NULL OR total <> inferred OR matching <> inferred
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
SELECT initialize_worker_topology();

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
