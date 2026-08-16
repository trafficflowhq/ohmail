ALTER TABLE "message_bodies" ADD COLUMN "body_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "subject_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(from_address, ''))) STORED;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_bodies_body_tsv_idx" ON "message_bodies" USING gin ("body_tsv");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_subject_tsv_idx" ON "messages" USING gin ("subject_tsv");