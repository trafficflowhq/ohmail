-- 0168_drafts_forward_parts — the pg column's twin (a JSON array of ids), appended last.

ALTER TABLE "drafts" ADD COLUMN "forward_parts" text;
