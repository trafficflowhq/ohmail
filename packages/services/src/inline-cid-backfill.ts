import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  messages, attachments, messageBodies, auditLog, recordChange, type Tx, auditAction,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { silentLogger, type Logger } from "@trafficflow/core";
import { referencesCid, HTML_TRUNCATION_MARKER } from "@trafficflow/core/mail";
import {
  realFileCount, ATTACHMENT_BACKFILL_LOCK_CLASS, ATTACHMENT_BACKFILL_LOCK_KEY,
  ATTACHMENT_FLAG_BATCH, ATTACHMENT_FLAG_MAX_PAGES,
} from "./attachment-flag-backfill.js";
import { bridgeTx, type Db } from "./context.js";

/**
 * A part the stored html references by `cid:` is inline — on rows ingested before `mime.ts`
 * promoted such parts at ingest. Only those: a part with a Content-ID the body never names stays
 * a file. The decision is the ingest's own {@link referencesCid}; the pair is recounted through
 * the paperclip pass's {@link realFileCount}, so the two backfills agree on every row. No marker:
 * the set does not drain (unreferenced parts stay candidates), so a re-run examines them again
 * and writes nothing. One `message`/`update` change and one audit inverse per corrected message.
 */

export interface InlineCidBackfillDeps {
  db: Db;
  /** Restrict to one mailbox. Absent ⇒ every mailbox. */
  mailboxId?: string;
  /** Start after this message id — the resume point a truncated run printed. */
  afterId?: string;
  log?: Logger;
  /** Test seam. Default {@link ATTACHMENT_FLAG_BATCH}. */
  batch?: number;
  /** Test seam. Default {@link ATTACHMENT_FLAG_MAX_PAGES}. */
  maxPages?: number;
  /** Test seam. Default {@link FLIP_CHUNK}. */
  flipChunk?: number;
  /** Test seam: awaited inside each page transaction after its writes, before the commit. */
  afterPageWrites?: () => Promise<void>;
}

export interface InlineCidBackfillResult {
  /** Candidate messages locked and examined. */
  examined: number;
  /** Messages with at least one part promoted. */
  corrected: number;
  /** Attachment rows promoted to `inline = true`. */
  promoted: number;
  /** The page cap was hit before the keyset ran out; resume with `afterId = lastExaminedId`. */
  truncated: boolean;
  lastExaminedId: string | null;
}

/** What the store can say about one candidate part. */
export type PartClass =
  | "referenced" | "not_referenced" | "no_body_or_withheld" | "no_html_stored"
  | "truncated_not_referenced";

interface StoredBody { html: string | null; withheldReason: string | null }

/** Attachment ids per promoting UPDATE. */
const FLIP_CHUNK = 500;

/**
 * The one classifier, for the plan and the apply alike. `html IS NULL` with no withheld reason is
 * its own class: the store cannot tell a text-only body from one stored without its html.
 */
export function classifyPart(body: StoredBody | undefined, contentId: string): PartClass {
  if (!body || body.withheldReason !== null) return "no_body_or_withheld";
  if (body.html === null) return "no_html_stored";
  if (referencesCid(body.html, contentId)) return "referenced";
  return body.html.endsWith(HTML_TRUNCATION_MARKER) ? "truncated_not_referenced" : "not_referenced";
}

/**
 * A candidate: a message with a part stored as a file that carries a Content-ID. Both halves of
 * the correlation are named in the identifier form (see {@link realFileCount} for why a bare
 * `${messages.id}` is unsafe) so `attachments_account_message_idx` carries the probe.
 */
function hasCidFile() {
  const col = (c: { name: string }) => sql`${messages}.${sql.identifier(c.name)}`;
  return sql`exists (
    select 1 from ${attachments} att
     where att.account_id = ${col(messages.accountId)}
       and att.message_id = ${col(messages.id)}
       and att.inline = false and coalesce(att.content_id, '') <> ''
  )`;
}

interface PageRow { messageId: string; accountId: string; mailboxId: string; has: boolean; count: number }
interface CandidatePart { id: string; messageId: string; contentId: string }

async function selectPage(
  t: Tx, opts: { mailboxId?: string; afterId?: string; limit: number; lock: boolean },
): Promise<PageRow[]> {
  const filters = [hasCidFile()];
  if (opts.mailboxId) filters.push(eq(messages.mailboxId, opts.mailboxId));
  if (opts.afterId) filters.push(gt(messages.id, sql`${opts.afterId}::uuid`));
  const q = t.select({
    messageId: messages.id, accountId: messages.accountId, mailboxId: messages.mailboxId,
    has: messages.hasAttachments, count: messages.attachmentCount,
  }).from(messages).where(and(...filters)).orderBy(asc(messages.id)).limit(opts.limit);
  return opts.lock ? q.for("update", { of: messages }) : q;
}

/** The bodies and candidate parts of one page — read AFTER the page's lock, never carried on it. */
async function readPage(t: Tx, page: PageRow[]): Promise<{
  bodies: Map<string, StoredBody>; parts: Map<string, CandidatePart[]>;
}> {
  const ids = page.map((r) => r.messageId);
  const bodies = new Map<string, StoredBody>();
  const parts = new Map<string, CandidatePart[]>();
  if (ids.length === 0) return { bodies, parts };
  const accountIds = [...new Set(page.map((r) => r.accountId))];
  for (const b of await t.select({
    messageId: messageBodies.messageId, html: messageBodies.html,
    withheldReason: messageBodies.withheldReason,
  }).from(messageBodies).where(inArray(messageBodies.messageId, ids))) {
    bodies.set(b.messageId, { html: b.html, withheldReason: b.withheldReason });
  }
  for (const p of await t.select({
    id: attachments.id, messageId: attachments.messageId, contentId: attachments.contentId,
  }).from(attachments).where(and(
    inArray(attachments.accountId, accountIds), inArray(attachments.messageId, ids),
    eq(attachments.inline, false), sql`coalesce(${attachments.contentId}, '') <> ''`,
  )).orderBy(asc(attachments.id))) {
    const list = parts.get(p.messageId) ?? [];
    list.push({ id: p.id, messageId: p.messageId, contentId: p.contentId! });
    parts.set(p.messageId, list);
  }
  return { bodies, parts };
}

export async function runInlineCidBackfill(deps: InlineCidBackfillDeps): Promise<InlineCidBackfillResult> {
  const tx = bridgeTx(deps.db);
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? ATTACHMENT_FLAG_BATCH;
  const maxPages = deps.maxPages ?? ATTACHMENT_FLAG_MAX_PAGES;
  const chunk = deps.flipChunk ?? FLIP_CHUNK;

  let examined = 0;
  let corrected = 0;
  let promoted = 0;
  let truncated = true;
  let afterId = deps.afterId;
  const touchedAccounts = new Set<string>();

  for (let page = 0; page < maxPages; page++) {
    const result = await tx.transaction(async (t) => {
      await dialect(deps.db).advisoryLock(t, ATTACHMENT_BACKFILL_LOCK_CLASS, ATTACHMENT_BACKFILL_LOCK_KEY);
      const rows = await selectPage(t, { mailboxId: deps.mailboxId, afterId, limit: batch, lock: true });
      const { bodies, parts } = await readPage(t, rows);
      let didCorrect = 0;
      let didPromote = 0;

      for (const row of rows) {
        const body = bodies.get(row.messageId);
        const flip = (parts.get(row.messageId) ?? [])
          .filter((p) => classifyPart(body, p.contentId) === "referenced")
          .map((p) => p.id);
        if (flip.length === 0) continue;

        // In slices: a message's part count has no ceiling, the bind-parameter limit does.
        for (let i = 0; i < flip.length; i += chunk) {
          await t.update(attachments).set({ inline: true }).where(and(
            eq(attachments.accountId, row.accountId), inArray(attachments.id, flip.slice(i, i + chunk)),
          ));
        }
        const real = realFileCount();
        const [next] = await t.update(messages)
          .set({ hasAttachments: sql`${real} > 0`, attachmentCount: real })
          .where(eq(messages.id, row.messageId))
          .returning({ has: messages.hasAttachments, count: messages.attachmentCount });

        // The delta: without it every mirror keeps the old paperclip.
        await recordChange(t, {
          accountId: row.accountId, entityType: "message", entityId: row.messageId, op: "update",
        });
        // The inverse is the flipped ids AND the prior pair: restoring one without the other is
        // a third state, not an undo.
        await t.insert(auditLog).values({
          accountId: row.accountId,
          action: auditAction("inline_cid_backfill_row"),
          payload: {
            messageId: row.messageId, attachmentIds: flip,
            hasAttachments: next!.has, attachmentCount: next!.count,
          },
          inverse: {
            messageId: row.messageId, inlineFalse: flip,
            hasAttachments: row.has, attachmentCount: row.count,
          },
        });
        touchedAccounts.add(row.accountId);
        didCorrect++;
        didPromote += flip.length;
      }
      await deps.afterPageWrites?.();
      return { rows, didCorrect, didPromote };
    });

    examined += result.rows.length;
    corrected += result.didCorrect;
    promoted += result.didPromote;
    if (result.rows.length === 0) { truncated = false; break; }
    afterId = result.rows[result.rows.length - 1]!.messageId;
  }

  const lastExaminedId = afterId ?? null;
  if (truncated) {
    log.warn("inline_cid_backfill_truncated", {
      mailboxId: deps.mailboxId ?? null, examined, corrected, promoted, maxPages, lastExaminedId,
      reason: "the page cap was reached — re-run apply with --after <lastExaminedId> to continue",
    });
    return { examined, corrected, promoted, truncated: true, lastExaminedId };
  }

  // One receipt per account actually touched; the per-message rows are the undo.
  if (touchedAccounts.size > 0) {
    await tx.transaction(async (t) => {
      for (const accountId of touchedAccounts) {
        await t.insert(auditLog).values({
          accountId,
          action: auditAction("inline_cid_backfill"),
          payload: { mailboxId: deps.mailboxId ?? null, examined, corrected, promoted },
          inverse: null,
        });
      }
    });
  }
  log.info("inline_cid_backfill_complete", {
    mailboxId: deps.mailboxId ?? null, examined, corrected, promoted,
  });
  return { examined, corrected, promoted, truncated: false, lastExaminedId };
}

export interface InlineCidPlanRow {
  mailboxId: string;
  /** Parts with a Content-ID stored as a file. */
  parts: number;
  referenced: number;
  notReferenced: number;
  noBodyOrWithheld: number;
  noHtmlStored: number;
  truncatedNotReferenced: number;
  /** Messages apply would correct (at least one referenced part). */
  messagesToCorrect: number;
}

/**
 * The READ-ONLY per-mailbox counts `plan` prints: the same candidate query and the same
 * classifier as apply, paged by keyset without a lock, no write.
 */
export async function planInlineCidBackfill(
  db: Db, opts: { mailboxId?: string; batch?: number } = {},
): Promise<InlineCidPlanRow[]> {
  const tx = bridgeTx(db);
  const batch = opts.batch ?? ATTACHMENT_FLAG_BATCH;
  const byMailbox = new Map<string, InlineCidPlanRow>();
  let afterId: string | undefined;
  for (;;) {
    const rows = await selectPage(tx, { mailboxId: opts.mailboxId, afterId, limit: batch, lock: false });
    if (rows.length === 0) break;
    const { bodies, parts } = await readPage(tx, rows);
    for (const row of rows) {
      const acc = byMailbox.get(row.mailboxId) ?? {
        mailboxId: row.mailboxId, parts: 0, referenced: 0, notReferenced: 0,
        noBodyOrWithheld: 0, noHtmlStored: 0, truncatedNotReferenced: 0, messagesToCorrect: 0,
      };
      let referencedHere = 0;
      for (const p of parts.get(row.messageId) ?? []) {
        acc.parts++;
        switch (classifyPart(bodies.get(row.messageId), p.contentId)) {
          case "referenced": acc.referenced++; referencedHere++; break;
          case "not_referenced": acc.notReferenced++; break;
          case "no_body_or_withheld": acc.noBodyOrWithheld++; break;
          case "no_html_stored": acc.noHtmlStored++; break;
          case "truncated_not_referenced": acc.truncatedNotReferenced++; break;
        }
      }
      if (referencedHere > 0) acc.messagesToCorrect++;
      byMailbox.set(row.mailboxId, acc);
    }
    afterId = rows[rows.length - 1]!.messageId;
  }
  return [...byMailbox.values()].sort((a, b) => a.mailboxId.localeCompare(b.mailboxId));
}
