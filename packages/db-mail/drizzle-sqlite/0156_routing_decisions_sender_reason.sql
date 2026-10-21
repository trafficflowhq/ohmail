-- 0156_routing_decisions_sender_reason — the pg column's twin: the fact that capped a stored
-- suggestion, which the local engine's act reads. Appends, no CHECK (the reader fails closed on a
-- value it does not know), NULL on every row stored before it.

ALTER TABLE "routing_decisions" ADD COLUMN "sender_reason" text;
