import { folderState, type Tx } from "@trafficflow/db";
import type { NormalizedMessage } from "@trafficflow/core/mail";

/**
 * WHAT THE RULE PASSES SHARE — the two writes every backwards-looking pass makes, in one place.
 *
 * `ohbox-tidy.ts`, `rule-retro.ts` and `screener-auto.ts` each decide something different and then
 * do the same two things: put a stored row into the shape the rules layer reads, and write the new
 * placement as an INTENT. Both stood as three copies whose own comments said they were identical;
 * A shared test reads the write through two of the passes and
 * each pass's own suite covers the third.
 */

/** The columns the rules layer reads off a stored row. Every pass's row shape satisfies it. */
export interface RuleInputRow {
  fromAddress: string;
  subject: string;
  headers: Record<string, string[]>;
  /**
   * `message_bodies.text` read back, or `""` — the haystack for a rule's `body_contains` term
   * (mail 0052), so a pass and ingest match against the same string. `""` satisfies no term: a
   * body rule declines to fire, fail-closed for a narrowing conjunct. A pass that evaluates no
   * rules passes `""` because that is the truth there, not a shortcut.
   */
  bodyText: string;
}

/**
 * The persisted row in the shape `evaluateRules` reads — sender, subject, headers and the stored
 * plain text, all on disk. No IMAP, no MIME re-parse. `htmlBody` stays empty because no rule reads
 * it; if one ever does, this is where that becomes a visible lie.
 */
export function ruleInputOf(row: RuleInputRow): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [],
    cc: [],
    date: null,
    headers: row.headers,
    textBody: row.bodyText,
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}

/** What the intent write needs off a row: which message, and where it sits right now. */
export interface PlacementRow { messageId: string; observedFolder: string }

/**
 * Write the INTENT and nothing else: the new desired folder, observed untouched. `reconcile_status`
 * is DERIVED (desired ≠ observed ⇒ `pending`), so a row can never claim a convergence it does not
 * have, and `pending` is what makes the worker's reconciler perform the physical move. An UPSERT,
 * never a delete — the placement is durable and the user can drag it back.
 */
export async function upsertDesired(
  t: Tx, row: PlacementRow, destination: string, now: Date,
): Promise<void> {
  const reconcileStatus = destination === row.observedFolder ? "reconciled" : "pending";
  await t.insert(folderState).values({
    messageId: row.messageId, desiredFolder: destination, observedFolder: row.observedFolder,
    lastSetBy: "us", reconcileStatus, conflict: false,
  }).onConflictDoUpdate({
    target: folderState.messageId,
    set: {
      desiredFolder: destination, observedFolder: row.observedFolder, lastSetBy: "us",
      reconcileStatus, conflict: false, updatedAt: now,
    },
  });
}

/**
 * Per-mailbox authserv trust, resolved at most once per mailbox per run. The value is
 * CONFIGURATION (which provider serves the mailbox), not row state, so caching across pages cannot
 * go stale within a pass. The read is issued on the OUTER handle — it joins no page transaction and
 * locks nothing a page holds; only its RESULT is used inside one.
 */
export function perMailboxAuthservTrust(
  db: Tx, read: (db: Tx, mailboxId: string) => Promise<ReadonlySet<string>>,
): (mailboxId: string) => Promise<ReadonlySet<string>> {
  const cache = new Map<string, ReadonlySet<string>>();
  return async (mailboxId: string): Promise<ReadonlySet<string>> => {
    const hit = cache.get(mailboxId);
    if (hit) return hit;
    const ids = await read(db, mailboxId);
    cache.set(mailboxId, ids);
    return ids;
  };
}
