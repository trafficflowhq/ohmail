-- 0159_rules_settled_press_at — the reader's press ordering on the device store, the pg column's
-- twin. Carried rather than noop'd: the phone and the desktop settle a reader's press over this
-- store too. `integer` here, `timestamptz` on the server. NULL for every existing rule.

ALTER TABLE "rules" ADD COLUMN "settled_press_at" integer;
