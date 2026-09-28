-- STAFF ROLES AND THE STAFF AUDIT (cloud 0047). `staff_role_grants` holds who may do what, read
-- live on every staff request; a row is revoked by stamping `revoked_at`, never deleted. Every
-- staff member who exists when this runs is granted `owner`, which is what they could do before.
-- `staff_audit_events` records every staff read and write the API serves, written before the
-- answer: append-only by trigger, and `target_account_id` carries no key on purpose, so an erased
-- account's rows survive under the id alone.
--
-- DEPLOY ORDER: migration, then re-run scripts/harden-staff-role.sql, then the API, in one window.

CREATE TABLE IF NOT EXISTS "staff_role_grants" (
  "staff_user_id" uuid NOT NULL REFERENCES "staff_users"("id"),
  "role" text NOT NULL,
  "granted_by" uuid REFERENCES "staff_users"("id"),
  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "revoked_by" uuid REFERENCES "staff_users"("id"),
  CONSTRAINT "staff_role_grants_pk" PRIMARY KEY ("staff_user_id", "role", "granted_at"),
  CONSTRAINT "staff_role_grants_role_closed" CHECK ("role" IN ('support', 'billing', 'ops', 'owner')),
  CONSTRAINT "staff_role_grants_revoked_together" CHECK (("revoked_at" IS NULL) = ("revoked_by" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_role_grants_live_uq"
  ON "staff_role_grants" ("staff_user_id", "role") WHERE "revoked_at" IS NULL;
--> statement-breakpoint
INSERT INTO "staff_role_grants" ("staff_user_id", "role", "granted_by")
  SELECT "id", 'owner', NULL FROM "staff_users"
  WHERE NOT EXISTS (SELECT 1 FROM "staff_role_grants" g WHERE g."staff_user_id" = "staff_users"."id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "request_id" uuid NOT NULL,
  "staff_user_id" uuid NOT NULL REFERENCES "staff_users"("id"),
  "staff_session_id" uuid,
  "actor_label" text NOT NULL,
  "roles" text[] NOT NULL,
  "action" text NOT NULL,
  "target_account_id" uuid,
  "target_user_id" uuid,
  "target_mailbox_id" uuid,
  "outcome" text NOT NULL,
  "refusal_code" text,
  "reason_code" text,
  "ticket_ref" text,
  "result_count" integer,
  "query_hmac" text,
  "audience" text,
  "detail" jsonb,
  CONSTRAINT "staff_audit_events_outcome_closed" CHECK ("outcome" IN ('ok', 'no_change', 'refused', 'failed')),
  CONSTRAINT "staff_audit_events_reason_closed" CHECK ("reason_code" IN (
    'customer_request', 'incident', 'billing_dispute', 'fraud_or_abuse', 'ops_maintenance', 'legal')),
  CONSTRAINT "staff_audit_events_ticket_shape" CHECK ("ticket_ref" ~ '^[A-Za-z0-9#._:-]{1,64}$')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_audit_events_account_at_idx" ON "staff_audit_events" ("target_account_id", "at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_audit_events_staff_at_idx" ON "staff_audit_events" ("staff_user_id", "at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_audit_events_request_idx" ON "staff_audit_events" ("request_id");
--> statement-breakpoint
-- APPEND-ONLY: one function refuses a row UPDATE or DELETE and a TRUNCATE alike.
CREATE OR REPLACE FUNCTION "staff_audit_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staff_audit_events is append-only' USING ERRCODE = '42501';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_audit_events_no_change" ON "staff_audit_events";
--> statement-breakpoint
CREATE TRIGGER "staff_audit_events_no_change" BEFORE UPDATE OR DELETE ON "staff_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "staff_audit_events_append_only"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "staff_audit_events_no_truncate" ON "staff_audit_events";
--> statement-breakpoint
CREATE TRIGGER "staff_audit_events_no_truncate" BEFORE TRUNCATE ON "staff_audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "staff_audit_events_append_only"();
--> statement-breakpoint
REVOKE TRUNCATE ON "staff_audit_events" FROM PUBLIC;
--> statement-breakpoint
REVOKE TRUNCATE ON "staff_audit_events" FROM CURRENT_USER;
