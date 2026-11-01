import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { auditLog, mailboxes } from "./schema-mail.js";
import { auditAction } from "./staff-channels.js";
import { dialect } from "./dialect/index.js";
import { fenceErased } from "./erasure-fence.js";
import { PROFILE_FOUND_AUDIT_ACTION } from "./organizer-profile-import.js";
import type { Tx } from "./change-log.js";

/**
 * A PRESS OF "IMPORT SETTINGS" THE REQUEST COULD NOT FINISH (mail 0129) — handed to the mailbox's
 * organizer, which reads the document on its own connection and answers here. Four columns on
 * the mailbox row, one per mailbox: the last press wins. The fingerprint is the ticket, the
 * consent to that exact content. The ONLY reader and writer of the columns, so both value sets
 * are closed here, on both stores, as `release_refusal` is.
 */

/** Why an ask ended without an import. Never provider text. */
export const IMPORT_ASK_REFUSALS = [
  "changed", "gone", "newer", "too_large", "unreadable", "timed_out", "not_organizer",
] as const;
export type ImportAskRefusal = (typeof IMPORT_ASK_REFUSALS)[number];
export const isImportAskRefusal = (v: unknown): v is ImportAskRefusal =>
  typeof v === "string" && (IMPORT_ASK_REFUSALS as readonly string[]).includes(v);

/** How long an ask may wait for an organizer before it reads as `timed_out`, never a spinner. */
export const PROFILE_IMPORT_ASK_TTL_MS = 10 * 60 * 1000;

export interface ImportAskRow {
  fingerprint: string | null;
  askedAt: Date | null;
  outcome: "imported" | "refused" | null;
  reason: ImportAskRefusal | null;
  organizerRole: string;
}

/** The row's ask, by primary key. Null when the mailbox is not this account's. */
export async function readImportAsk(
  db: Tx, o: { accountId: string; mailboxId: string },
): Promise<ImportAskRow | null> {
  const [row] = await db.select({
    fingerprint: mailboxes.profileImportAskFingerprint,
    askedAt: mailboxes.profileImportAskAt,
    outcome: mailboxes.profileImportAskOutcome,
    reason: mailboxes.profileImportAskReason,
    organizerRole: mailboxes.organizerRole,
  }).from(mailboxes)
    .where(and(eq(mailboxes.id, o.mailboxId), eq(mailboxes.accountId, o.accountId))).limit(1);
  if (row === undefined) return null;
  return {
    fingerprint: row.fingerprint,
    askedAt: row.askedAt === null ? null : new Date(row.askedAt),
    outcome: row.outcome === "imported" || row.outcome === "refused" ? row.outcome : null,
    reason: isImportAskRefusal(row.reason) ? row.reason : null,
    organizerRole: row.organizerRole,
  };
}

/** A standing ask: pressed, unanswered and inside the TTL. */
export function askStands(row: ImportAskRow | null, now: Date): row is ImportAskRow & { fingerprint: string; askedAt: Date } {
  return row !== null && row.fingerprint !== null && row.askedAt !== null && row.outcome === null
    && now.getTime() - row.askedAt.getTime() < PROFILE_IMPORT_ASK_TTL_MS;
}

/**
 * Record the press, in the caller's fenced transaction. An identical ask already standing is
 * not written again; anything else — another document's ask, an answered one — is replaced.
 * Returns whether a row was written.
 */
export async function recordImportAsk(
  tx: Tx, o: { accountId: string; mailboxId: string; fingerprint: string; now: Date },
): Promise<boolean> {
  const row = await readImportAsk(tx, o);
  if (row === null) return false;
  if (askStands(row, o.now) && row.fingerprint === o.fingerprint) return false;
  await tx.update(mailboxes).set({
    profileImportAskFingerprint: o.fingerprint, profileImportAskAt: o.now,
    profileImportAskOutcome: null, profileImportAskReason: null,
  }).where(and(eq(mailboxes.id, o.mailboxId), eq(mailboxes.accountId, o.accountId)));
  return true;
}

/**
 * WHAT THE CARD SAID OF THE SIGNATURE, for a press handed to the organizer: the receipt of the
 * mailbox's signature the card said the copy's replaces (`signatureReceipt`). An audit row beside
 * the ask's columns, written with the ask only when the press named one.
 */
export const PROFILE_IMPORT_ASK_SIGNATURE_AUDIT_ACTION = "organizer_profile_import_ask_signature";

/** Record the receipt a handed-over press named, at the ask's own instant. */
export async function recordImportAskSignature(
  tx: Tx, o: { accountId: string; mailboxId: string; fingerprint: string; signatureReplaces: string; at: Date },
): Promise<void> {
  // Fenced at its own site: no row lands for an erased account or mailbox (a fenced caller's account arm is free).
  await fenceErased(tx, dialect(tx), { accountId: o.accountId, mailboxId: o.mailboxId });
  await tx.insert(auditLog).values({
    accountId: o.accountId,
    action: auditAction(PROFILE_IMPORT_ASK_SIGNATURE_AUDIT_ACTION),
    payload: { mailboxId: o.mailboxId, fingerprint: o.fingerprint, signatureReplaces: o.signatureReplaces },
    inverse: null,
    createdAt: o.at,
  });
}

/**
 * The receipt the press behind the standing ask named, or null: the newest row for this document at
 * or after the ask's instant (`since`), so an earlier ask's word never carries over to a later one.
 */
export async function importAskSignature(
  db: Tx, o: { accountId: string; mailboxId: string; fingerprint: string; since: Date },
): Promise<string | null> {
  const [row] = await db.select({ payload: auditLog.payload }).from(auditLog)
    .where(and(
      eq(auditLog.accountId, o.accountId),
      eq(auditLog.action, PROFILE_IMPORT_ASK_SIGNATURE_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
      sql`${auditLog.payload}->>'fingerprint' = ${o.fingerprint}`,
      gte(auditLog.createdAt, o.since),
    ))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const said = (row?.payload as { signatureReplaces?: unknown } | null | undefined)?.signatureReplaces;
  return typeof said === "string" && said.length > 0 ? said : null;
}

/** The key under which each action's payload names a signature by its receipt. */
const RECEIPT_KEY: Readonly<Record<string, string>> = {
  [PROFILE_FOUND_AUDIT_ACTION]: "signatureReceipt",
  [PROFILE_IMPORT_ASK_SIGNATURE_AUDIT_ACTION]: "signatureReplaces",
};

/**
 * THE AUDIT ROWS THAT NAME ONE MAILBOX'S SIGNATURE BY A RECEIPT — the found-marker's (the copy's) and
 * a handed-over press's (the mailbox's own) — each with its payload as it reads with the receipt
 * taken off. They age out with the audit trail; a mailbox's erasure writes these payloads back
 * (`mailbox-erasure.ts`, and the device's removal walk), so no receipt outlives the mailbox's signature.
 */
export async function signatureReceiptRows(
  db: Tx, o: { accountId?: string; mailboxId: string },
): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const rows = await db.select({ id: auditLog.id, action: auditLog.action, payload: auditLog.payload }).from(auditLog)
    .where(and(
      o.accountId === undefined ? undefined : eq(auditLog.accountId, o.accountId),
      or(eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION), eq(auditLog.action, PROFILE_IMPORT_ASK_SIGNATURE_AUDIT_ACTION)),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
    ));
  const out: Array<{ id: string; payload: Record<string, unknown> }> = [];
  for (const r of rows) {
    const key = RECEIPT_KEY[r.action];
    if (key === undefined || r.payload === null || typeof r.payload !== "object" || !(key in r.payload)) continue;
    const payload = { ...(r.payload as Record<string, unknown>) };
    delete payload[key];
    out.push({ id: r.id, payload });
  }
  return out;
}

/**
 * Answer the ask for `fingerprint` — COMPARE-AND-SET on the ticket, so a newer press that
 * replaced it mid-merge keeps its pending state. Nothing is written when another document's
 * ask stands or none does (an inline import asked nobody). Returns whether it answered.
 */
export async function resolveImportAsk(
  tx: Tx,
  o: { accountId: string; mailboxId: string; fingerprint: string }
    & ({ outcome: "imported" } | { outcome: "refused"; reason: ImportAskRefusal }),
): Promise<boolean> {
  if (o.outcome === "refused" && !isImportAskRefusal(o.reason)) {
    throw new Error(`profile_import_ask_reason holds a closed set and ${JSON.stringify(o.reason)} is not a member`);
  }
  const done = await tx.update(mailboxes).set({
    profileImportAskOutcome: o.outcome,
    profileImportAskReason: o.outcome === "refused" ? o.reason : null,
  }).where(and(
    eq(mailboxes.id, o.mailboxId), eq(mailboxes.accountId, o.accountId),
    eq(mailboxes.profileImportAskFingerprint, o.fingerprint),
  )).returning({ id: mailboxes.id });
  return done.length > 0;
}
