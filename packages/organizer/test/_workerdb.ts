import { and, eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { PG_TEST_URL, journalDrift, pgTestUrl } from "@trafficflow/db/testing";

/*
 * THE WORKER TESTS' POSTGRES HALF, WITH NO MAIL SERVER IN ITS IMPORTS. `scripts/box-files.mjs`
 * follows imports, and `_workerenv.ts` reaches `_greenmail-ports.ts`, so a file that took only
 * `DB_URL` from there was put on the GreenMail lock it never used. A file that needs nothing but
 * these names imports them from here; `_workerenv.ts` re-exports every one, unchanged.
 */

/** This checkout's lane database when it has one — the one resolver, `PG_TEST_URL`. */
export const DB_URL = PG_TEST_URL;

/** The same URL for a file that dials it: `pgTestUrl`, which refuses the shared box by the file's name. */
export const dbUrlFor = pgTestUrl;

/**
 * THE SHARED DATABASE IS REFUSED WHEN ITS JOURNAL IS NOT THIS TREE'S. `journalDrift` answers the
 * question; this door REFUSES and drops nothing, unlike `prepareIsolatedDb`, which recreates a
 * database only this checkout names. It runs before the first statement, so a stale schema is
 * named here rather than as a failure of the component under test. An unreadable journal is
 * refused too: neither drift nor its absence is a reason to proceed.
 */
export async function refuseDriftedSharedDb(url: string = DB_URL): Promise<void> {
  let drift: string | null;
  try {
    drift = await journalDrift(url);
  } catch (e) {
    drift = `its migration journals could not be read at all (${e instanceof Error ? e.message : String(e)}), `
      + "so whether its schema is this tree's is unknown — neither drift nor its absence.";
  }
  if (drift === null) return;
  throw new Error(
    `refusing to run against ${new URL(url).host}${new URL(url).pathname}: it is not this tree's `
      + `schema — ${drift} Reset it to this tree's journals and run again; nothing was measured.`,
  );
}

/** Re-exported from its own module so a PGlite file can take it without the box. */
export { repoWithFailingMethod } from "./_fault.js";

/**
 * An ingested message by its Message-ID (RFC 5322) inside one mailbox. `dedup_key` is a fingerprint
 * no test can spell; `message_id_header` is what these tests mean, and case is significant
 * (RFC 5322 §3.6.4), so the value must match the header as written.
 */
export function byMessageId(mailboxId: string, messageId: string) {
  return and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, messageId));
}

/**
 * THE TWO COLUMNS THAT MAKE A FIXTURE MAILBOX ONE SOMEBODY AGREED TO ORGANIZE. `mayOrganize`
 * refuses a mailbox whose consent and takeover stamps are both NULL and returns before the lease,
 * so a bare fixture row is a consent-less READER. The stamp is in the past on purpose: consent is
 * a standing fact, while `takeover_authorized_at` is spent by the pass that reads it.
 */
export const ORGANIZER_CONSENT = {
  organizerRole: "organizer" as const,
  organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
};
