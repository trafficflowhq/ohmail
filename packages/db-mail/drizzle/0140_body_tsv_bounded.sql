-- THE BODY VECTOR IS BOUNDED (mail 0140). `message_bodies.body_tsv` was a stored generated column
-- over the whole `text`, so a body of distinct words past ~900 KiB made a tsvector over its 1 MiB
-- ceiling (54000) inside the ingest transaction and the message could not be stored. The column
-- keeps every value as a plain tsvector (DROP EXPRESSION rewrites nothing); a trigger computes it
-- over the first 65,536 characters, `text_tsv`'s bound since 0125. `text` is never cut, and a
-- withheld body (text = '') empties its vector. The column's eventual drop takes both objects.
-- `data_too_large` joins the failure codes: drop-then-add, NOT VALID, 0134's shape and reason.
-- DEPLOY ORDER: migration, then API and worker. Every statement repeats safely.

ALTER TABLE "message_bodies" ALTER COLUMN "body_tsv" DROP EXPRESSION IF EXISTS;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "message_bodies_body_tsv_bounded"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.body_tsv := to_tsvector('english', left(coalesce(NEW.text, ''), 65536));
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "message_bodies_body_tsv_tg" ON "message_bodies";
--> statement-breakpoint
CREATE TRIGGER "message_bodies_body_tsv_tg" BEFORE INSERT OR UPDATE OF "text" ON "message_bodies"
  FOR EACH ROW EXECUTE FUNCTION "message_bodies_body_tsv_bounded"();
--> statement-breakpoint
ALTER TABLE "message_failures" DROP CONSTRAINT IF EXISTS "message_failures_code_closed";
--> statement-breakpoint
ALTER TABLE "message_failures" ADD CONSTRAINT "message_failures_code_closed"
  CHECK ("code" in ('mime_too_large','mime_unparseable','data_exception','data_too_large','constraint_violation','unclassified')) NOT VALID;
