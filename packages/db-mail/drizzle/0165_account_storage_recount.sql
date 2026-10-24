-- 0165_account_storage_recount — an erased mailbox's bytes leave the storage counter. Until this
-- release "Remove and erase" deleted a mailbox's bodies without lowering `account_storage`, and the
-- trim then emptied the text of the account's kept letters to pay the phantom bytes down. The erase
-- now gives the bytes back and recounts at its finish; this recounts once every account that has an
-- erased mailbox, the same sum `recomputeAccountStorage` writes. Accounts without one keep their
-- counter; an account with no counter row has nothing to repair. The counter table is locked first,
-- so the sum is taken after every in-flight reservation commits.
-- LOCK-WAIT: SHARE ROW EXCLUSIVE on account_storage until the pass commits, then one aggregate over the
-- erased accounts' bodies by message. Counter writers (ingest reserves, trims, erase steps) queue on the
-- table and hold no lock on it while they wait, so a later statement of the same pass that alters
-- account_storage (0166) upgrades its lock without a deadlock; a writer past its lock_timeout retries.
-- DEPLOY ORDER: migration, then worker. Nothing here is DDL the worker needs, so this file alone is safe
-- either way, but a release that also carries 0166 must migrate first (the new worker writes its
-- columns). Both statements repeat safely. An erase an older worker finishes after this ran (a lagging
-- deploy, a worker rollback) leaves its bytes on the counter again; the new worker's trim recounts any
-- account with an erased mailbox before it empties anything, and the next erase's finish recounts too.
-- ROLLBACK: none needed; the counter is derived.

LOCK TABLE "account_storage" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
UPDATE "account_storage" s
   SET "bytes" = coalesce((SELECT sum(octet_length(b."text") + coalesce(octet_length(b."html"), 0))
                             FROM "message_bodies" b JOIN "messages" m ON m."id" = b."message_id"
                            WHERE m."account_id" = s."account_id"), 0),
       "updated_at" = now()
 WHERE s."account_id" IN (SELECT "account_id" FROM "mailboxes" WHERE "erased_at" IS NOT NULL);
