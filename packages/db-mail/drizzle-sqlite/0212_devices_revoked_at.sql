-- 0212_devices_revoked_at — the pg column's twin: when a named device was taken back in Devices, as epoch ms.
-- NULL for every other device; stamped once and never cleared. The settings record counts the rows that carry it.

ALTER TABLE "devices" ADD COLUMN "revoked_at" integer;
