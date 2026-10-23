-- 0164_messages_server_missing — the pg column's twin (epoch ms). The entry's class CHECKs are not
-- carried, for 0097's reason: they live on the Postgres journal alone.

ALTER TABLE "messages" ADD COLUMN "server_missing_at" integer;
