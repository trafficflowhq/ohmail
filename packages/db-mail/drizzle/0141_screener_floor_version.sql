-- 0141_screener_floor_version — the Screener auto-apply pass's verdict on a held row's bulk floor.
--
-- NULL = this row's strong-bulk floor is unjudged, or its judgment was withdrawn. N = the pass read
-- the floor empty for this message under floor version N (`STRONG_BULK_FLOOR_VERSION`) with a body
-- row present, so its hourly walk does not read the row again. Not desired state: no reconciler or
-- mirror reads it. NULL on every existing row, no backfill; the index is a hot-path spec.
-- ROLLBACK is `ALTER TABLE folder_state DROP COLUMN screener_floor_version`.

ALTER TABLE "folder_state" ADD COLUMN IF NOT EXISTS "screener_floor_version" integer;
