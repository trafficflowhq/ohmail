-- 0176_messages_unconfirmed_hold — the pg column's twin (1 when held this way, NULL otherwise).

ALTER TABLE "messages" ADD COLUMN "unconfirmed_hold" integer;
