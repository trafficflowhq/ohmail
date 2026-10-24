-- 0169_mailboxes_organized_through — the pg column's twin (epoch ms).

ALTER TABLE "mailboxes" ADD COLUMN "organized_through" integer;
