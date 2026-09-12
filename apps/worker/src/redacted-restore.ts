import { and, asc, eq, gt, sql } from "drizzle-orm";
import { applyBodyBytesDelta, auditLog, bodyBytesOf, messageBodies, messages, recordChange, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  fingerprintDedupKey, messageFingerprint, normalizeMessageId, normalizeMime,
  prepareHtmlForStorage, silentLogger,
  type Logger, type NativeLocator, type NormalizedMessage,
} from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";

/* RESTORING THE FULL BODY OF HISTORICALLY-REDACTED SENSITIVE MAIL — one-off, scoped. Ingest now stores the
 * full text/html of sensitive mail and withholds only the FLAGS, but rows ingested before that still hold
 * the literal `[REDACTED]`, so a genuinely-sensitive message renders as `[REDACTED]` for ever (the original
 * is only on the server). NOT `sensitive-backfill.ts`: that pass re-classifies and CLEARS flags where the
 * fixed classifier says `ordinary`; this does the OPPOSITE (the rows here are genuinely sensitive — it KEEPS
 * every flag and only puts the body back), and it touches neither `sensitive_fp_backfill_at` nor its
 * concurrency hazard. Idempotency is the predicate `message_bodies.text LIKE '%[REDACTED]%'` (a restored row
 * drops out; no `done_at` — the shrinking set is the bookmark); a fetched-and-refused row keeps the
 * placeholder, shelved in a per-run in-memory {@link refused}. Reads with `fetchRaw` = `BODY.PEEK[]` (no
 * `\Seen`, `imap.ts`), moves/flags/deletes nothing. Per mailbox, ids passed explicitly; not wired into the cycle. */

/** Categorised rows examined per SQL page. Held in memory across the per-row network reads. */
export const REDACTED_RESTORE_BATCH = 100;

/** Messages re-read from the mail server per invocation — the reconciler-heartbeat bound. */
export const REDACTED_RESTORE_FETCHES_PER_CYCLE = 50;

/** SQL pages one invocation may walk before giving up and saying so. A bound, not `while (true)`. */
export const REDACTED_RESTORE_MAX_PAGES = 500;

/** Per-message byte ceiling for the re-read. Over it, the row is left redacted (its bytes are the
 * one thing we could not read). 8 MiB — sensitive mail can carry an attachment. */
export const REDACTED_RESTORE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Messages this PROCESS re-read and declined, per mailbox — and why per-process is CORRECT here where it
 * was not in `sensitive-backfill.ts`. The rule (the same `junk-restore.ts` states): a process-scoped shelf
 * is safe exactly while it cannot be LAUNDERED INTO A DURABLE CLAIM — losing it must cost work, never
 * correctness. This pass has NO completion marker (it is an operator CLI, `run-redacted-restore.ts`, and
 * nothing on disk ever says "done"), so a restart re-attempts every refusal, the safe direction (a re-read
 * of a message still sitting redacted). The sibling that broke the rule: `sensitive-backfill` kept the
 * identical shelf gated by a durable marker, so one transient fetch failure refused a message permanently
 * (fixed 2026-09-01 by splitting decided from undecided refusals). A durable "done" marker here without
 * moving this set to disk would re-create that defect one file over. */
const refusedByMailbox = new Map<string, Set<string>>();
function refusedFor(mailboxId: string): Set<string> {
  const hit = refusedByMailbox.get(mailboxId);
  if (hit) return hit;
  const fresh = new Set<string>();
  refusedByMailbox.set(mailboxId, fresh);
  return fresh;
}

/** Over the ceiling, thrown from `RFC822.SIZE` before any bytes moved — the connection is fine. */
function isOverCeiling(err: unknown): boolean {
  return typeof err === "object" && err !== null
    && (err as { code?: unknown }).code === "ERAWTOOLARGE";
}

export interface RedactedRestoreDeps {
  db: Tx;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  log?: Logger;
  now?: () => Date;
  batch?: number;
  fetchesPerCycle?: number;
  maxPages?: number;
  maxBytes?: number;
  /** Test seam for the in-memory refusal set. */
  refused?: Set<string>;
}

export interface RedactedRestoreResult {
  /** Categorised rows the SQL walk looked at. */
  examined: number;
  /** Messages re-read from the mail server. */
  fetched: number;
  /** Already re-read and declined this process (see {@link refusedFor}). */
  skipped: number;
  /** Bodies restored: full text + html stored, snippet refreshed, FLAGS UNCHANGED. */
  restored: number;
  /** Gone, over the ceiling, or unparseable — left redacted. */
  unreadable: number;
  /** The locator no longer holds this message — left redacted (storing would cross messages). */
  mismatched: number;
  /** The per-cycle fetch budget ran out; the rest resumes on the next invocation. */
  capped: boolean;
}

const EMPTY: RedactedRestoreResult = {
  examined: 0, fetched: 0, skipped: 0, restored: 0, unreadable: 0, mismatched: 0, capped: false,
};

interface CandidateRow {
  messageId: string;
  dedupKey: string;
  messageIdHeader: string | null;
  locator: NativeLocator | null;
}

/** The idempotency predicate AND the safety recheck: the stored text still holds the placeholder. */
const STILL_REDACTED = sql`${messageBodies.text} like '%[REDACTED]%'`;

/**
 * THE PASS. Once per mailbox: re-read the originals of messages whose body is still the redaction
 * placeholder, and store the full body — keeping every sensitivity flag.
 */
export async function redactedRestorePass(
  deps: RedactedRestoreDeps,
): Promise<RedactedRestoreResult> {
  const { db, adapter, accountId, mailboxId } = deps;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? REDACTED_RESTORE_BATCH;
  const fetchBudget = deps.fetchesPerCycle ?? REDACTED_RESTORE_FETCHES_PER_CYCLE;
  const maxPages = deps.maxPages ?? REDACTED_RESTORE_MAX_PAGES;
  const maxBytes = deps.maxBytes ?? REDACTED_RESTORE_MAX_BYTES;

  if (!adapter.fetchRaw) {
    log.warn("redacted_restore_unsupported", {
      mailboxId, accountId,
      reason: "this adapter cannot re-read a whole message, so redacted bodies are left as they are",
    });
    return { ...EMPTY };
  }

  const result: RedactedRestoreResult = { ...EMPTY };
  const refused = deps.refused ?? refusedFor(mailboxId);
  let cursor: string | null = null;

  for (let pages = 0; pages < maxPages; pages++) {
    if (result.fetched >= fetchBudget) { result.capped = true; break; }

    const page = await selectCandidates(db, { mailboxId, limit: batch, afterId: cursor });
    result.examined += page.length;
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.messageId;

    for (const row of page) {
      if (result.fetched >= fetchBudget) { result.capped = true; break; }
      if (refused.has(row.messageId)) { result.skipped++; continue; }
      if (!row.locator) { refused.add(row.messageId); result.unreadable++; continue; }

      let fresh: NormalizedMessage;
      try {
        const raw = await adapter.fetchRaw(row.locator, { maxBytes });
        result.fetched++;
        fresh = await normalizeMime(Buffer.from(raw));
      } catch (err) {
        result.fetched++;
        // Over the ceiling: the original's bytes are exactly what we could not read, so there is
        // nothing to restore FROM. Refuse it (keeps the placeholder) and move on — unlike
        // `sensitive-backfill`, there is no "clear from stored" fallback, because this pass does
        // not re-decide anything; it only puts bytes back, and it has none.
        if (isOverCeiling(err)) {
          refused.add(row.messageId);
          result.unreadable++;
          log.warn("redacted_restore_oversize", {
            mailboxId, accountId, messageId: row.messageId,
            reason: "the original is over the re-read ceiling; the body stays redacted",
          });
          continue;
        }
        result.unreadable++;
        refused.add(row.messageId);
        log.warn("redacted_restore_unreadable", {
          mailboxId, accountId, messageId: row.messageId, err,
          reason: "the original could not be re-read; the body stays redacted",
        });
        continue;
      }

      if (!isSameMessage(row, fresh)) {
        result.mismatched++;
        refused.add(row.messageId);
        log.warn("redacted_restore_identity_mismatch", {
          mailboxId, accountId, messageId: row.messageId,
          reason: "the locator no longer resolves to this message — nothing written, because " +
            "storing these bytes would put one person's mail into another message's row",
        });
        continue;
      }

      if (await restoreOne(db, accountId, row.messageId, fresh, now())) result.restored++;
    }
    if (result.capped) break;
    if (page.length < batch) break;
  }

  if (result.restored > 0 || result.fetched > 0) {
    await db.insert(auditLog).values({
      accountId, action: "redacted_body_restore",
      payload: {
        mailboxId, examined: result.examined, fetched: result.fetched, skipped: result.skipped,
        restored: result.restored, unreadable: result.unreadable, mismatched: result.mismatched,
      },
      inverse: null,
    });
    log.info("redacted_restore_complete", {
      mailboxId, accountId, examined: result.examined, fetched: result.fetched,
      restored: result.restored, unreadable: result.unreadable, mismatched: result.mismatched,
      capped: result.capped,
    });
  }
  return result;
}

/**
 * One page of the still-redacted mail in one mailbox, oldest id first. Cursor-paged (a refused row
 * keeps the placeholder and stays a candidate, so a "select where still redacted, no cursor" would
 * re-read the same refusals every page). NOT locked — the page is held across network reads;
 * {@link restoreOne} takes the row lock at the moment it writes.
 */
async function selectCandidates(
  db: Tx, opts: { mailboxId: string; limit: number; afterId: string | null },
): Promise<CandidateRow[]> {
  const filters = [eq(messages.mailboxId, opts.mailboxId), STILL_REDACTED];
  if (opts.afterId) filters.push(gt(messages.id, sql`${opts.afterId}::uuid`));

  const rows = await db.select({
    messageId: messages.id,
    dedupKey: messages.dedupKey,
    messageIdHeader: messages.messageIdHeader,
    locator: messages.nativeLocator,
  }).from(messages)
    .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(...filters))
    .orderBy(asc(messages.id))
    .limit(opts.limit);

  return rows.map((r) => ({
    messageId: r.messageId,
    dedupKey: r.dedupKey,
    messageIdHeader: r.messageIdHeader,
    locator: (r.locator as NativeLocator | null) ?? null,
  }));
}

/**
 * Store the full body for ONE message, and answer whether this call did it. THE LOCK-AND-RECHECK IS THE
 * IDEMPOTENCY: the `FOR UPDATE` re-read requires the stored text to STILL hold the placeholder, so a second
 * driver or a re-run finds it already restored and writes nothing (one restore, one `change_log` delta). A
 * transaction PER MESSAGE, opened AFTER the network read, so a mail server's response time is never held
 * inside `recordChange`'s account row lock. FLAGS ARE UNTOUCHED — `sensitivity_category`, `no_ai`, `no_kb`,
 * `no_forward`, `priority` are not in the `set` (this row is genuinely sensitive); only the body, snippet
 * and `updated_at` move. That is the whole difference from `sensitive-backfill.ts#repairOne`.
 */
async function restoreOne(
  db: Tx, accountId: string, messageId: string, fresh: NormalizedMessage, now: Date,
): Promise<boolean> {
  const d = dialect(db);
  return db.transaction(async (tx) => {
    const [live] = await tx.select({
      id: messageBodies.messageId,
      // The OLD body's octets, read under the same lock the rewrite holds, so the byte
      // accounting below is a delta between two states this transaction has both seen.
      oldBytes: sql<number>`octet_length(${messageBodies.text}) + coalesce(octet_length(${messageBodies.html}), 0)`,
    }).from(messageBodies)
      .where(and(eq(messageBodies.messageId, messageId), STILL_REDACTED))
      .limit(1)
      .for("update");
    if (!live) return false;

    const storedText = fresh.textBody;
    const storedHtml = prepareHtmlForStorage(fresh.htmlBody);
    await tx.update(messageBodies).set({
      text: storedText,
      html: storedHtml,
    }).where(eq(messageBodies.messageId, messageId));

    // KEEP THE COUNTER TRUE: this rewrite changes the row's stored bytes, so the same
    // transaction moves `account_storage` by the difference — BEFORE the `recordChange` below,
    // the lock order every counter writer holds. `applyBodyBytesDelta` clamps at zero, so a
    // pre-backfill row can never abort the restore this pass exists to make. Deliberately NOT
    // gated on any cap: this is a REPAIR of a body the account already owns, not new storage,
    // and blocking a repair on a billing state would be destroying data by another name.
    await applyBodyBytesDelta(
      tx, d, accountId,
      bodyBytesOf({ text: storedText, html: storedHtml }) - Number(live.oldBytes),
    );

    await tx.update(messages).set({
      snippet: snippetOf(fresh),
      updatedAt: now,
    }).where(eq(messages.id, messageId));

    await recordChange(tx, {
      accountId, entityType: "message", entityId: messageId, op: "update", meta: null,
    });
    return true;
  });
}

/** Two independent witnesses that the re-read is the row's message — identical to
 * `sensitive-backfill.ts#isSameMessage`, and load-bearing for the same reason. */
function isSameMessage(row: CandidateRow, fresh: NormalizedMessage): boolean {
  if (fingerprintDedupKey(messageFingerprint(fresh)) === row.dedupKey) return true;
  const stored = normalizeMessageId(row.messageIdHeader);
  const got = normalizeMessageId(fresh.canonical.messageIdHeader);
  return stored !== null && got !== null && stored === got;
}

/** The same three operations `pipeline.ts#bodySnippet` performs — the full text, never redacted. */
function snippetOf(normalized: NormalizedMessage): string {
  return normalized.textBody.replace(/\s+/g, " ").trim().slice(0, 200);
}

export const __snippetOf = snippetOf;
