import { and, desc, eq, gte, sql } from "drizzle-orm";
import { auditLog } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * THE PORTABLE PROFILE'S IMPORT MARKERS — the durable conversation between the organizer that
 * FINDS a travelling settings document and the surface that asks the user about it.
 *
 * The document itself lives in the mailbox (`ohmail/_meta`; the format is
 * `packages/core/src/adapters/organizer-profile.ts`). What lives HERE is the bookkeeping around
 * the one decision the organizer refuses to make on its own — *shall these found settings be
 * applied?* — recorded in `audit_log` because that is the one generic, account-scoped marker
 * table every deployment already carries in its mail half.
 *
 * Two actions, two writers, one reader each:
 *
 *  · {@link PROFILE_FOUND_AUDIT_ACTION} — written by the ORGANIZER when it meets a document it
 *    will not silently adopt or overwrite (`apps/worker/src/profile.ts`), read by the import
 *    surface to know whether there is anything to ask about.
 *  · {@link PROFILE_IMPORT_RESOLVED_AUDIT_ACTION} — written by the IMPORT SURFACE when the user
 *    answers (applied, or declined), read back by the organizer to release the hold that was
 *    keeping it from writing over the document while the question was open.
 *
 * ── ON THE ROOT BARREL, FOR THE `screener-suggestion.ts` REASON ────────────────────────────
 *
 * The callers straddle the deployment: the answer-side helpers are called from
 * `@trafficflow/services`, and the organizer-side read runs in the worker, which may import
 * core and db and nothing else from the workspace. This module reaches `schema-mail.js` alone,
 * so it is inside the root barrel's closure rule.
 */

/**
 * The `audit_log.action` under which a found foreign profile is recorded — one row per DISTINCT
 * found document, deduplicated by the writer on the document's fingerprint. Payload:
 * `{ mailboxId, state: "found" | "newer", fingerprint, heldForImport, updatedAt?, producer?,
 * counts?, v? }`.
 */
export const PROFILE_FOUND_AUDIT_ACTION = "organizer_profile_found";

/**
 * The `audit_log.action` under which the USER'S ANSWER to a found document is recorded.
 * Payload: `{ mailboxId, fingerprint, decision: "imported" | "declined", v? }` — `fingerprint`
 * names the exact document content that was answered (null for the `newer` state, which has no
 * readable payload to fingerprint; `v` carries the refused version instead).
 *
 * The row is the durable half of both buttons: *Import* writes it in the same transaction as
 * the applied sections, and *Not now* writes it alone. Either way the organizer's next admitted
 * cycle reads it and releases the hold — the local store, imported-into or deliberately kept,
 * is the user-ratified truth from that moment, and write-behind resumes.
 */
export const PROFILE_IMPORT_RESOLVED_AUDIT_ACTION = "organizer_profile_import_resolved";

export type ProfileImportDecision = "imported" | "declined";

/** The found-marker payload, as `apps/worker/src/profile.ts#writeMarker` shapes it. */
export interface ProfileFoundMarker {
  mailboxId: string;
  state: "found" | "newer";
  /** The found document's PAYLOAD fingerprint; null for `newer` (unreadable at this version). */
  fingerprint: string | null;
  heldForImport: boolean;
  /** `newer` only: the version that refused this build. */
  v?: number;
  /** `found` only: the document's own write stamp and provenance. */
  updatedAt?: string;
  producer?: { kind: string; version: string };
  counts?: {
    screener: number; rules: number; notifyRules: number; tagNames: number; awayResponder: number;
  };
}

/**
 * The NEWEST found-marker for one mailbox, or null when the organizer has never surfaced a
 * document there. Newest by `created_at` because the writer deduplicates per distinct document:
 * a later row means a later fact (a different document, or the same one re-surfaced with a
 * different posture), and the import surface must answer for the current one.
 */
export async function latestProfileFoundMarker(
  db: Tx, accountId: string, mailboxId: string,
): Promise<ProfileFoundMarker | null> {
  const [row] = await db.select({ payload: auditLog.payload })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, accountId),
      eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${mailboxId}`,
    ))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row) return null;
  const p = row.payload as Partial<ProfileFoundMarker> | null;
  if (!p || typeof p.mailboxId !== "string" || (p.state !== "found" && p.state !== "newer")) return null;
  return {
    mailboxId: p.mailboxId,
    state: p.state,
    fingerprint: typeof p.fingerprint === "string" ? p.fingerprint : null,
    heldForImport: p.heldForImport === true,
    ...(typeof p.v === "number" ? { v: p.v } : {}),
    ...(typeof p.updatedAt === "string" ? { updatedAt: p.updatedAt } : {}),
    ...(p.producer && typeof p.producer === "object" ? { producer: p.producer as { kind: string; version: string } } : {}),
    ...(p.counts && typeof p.counts === "object" ? { counts: p.counts as ProfileFoundMarker["counts"] } : {}),
  };
}

/** What a resolution names: the exact document content (v1), or the refused version (newer). */
export type ProfileImportSubject =
  | { fingerprint: string }
  | { newerV: number };

/**
 * Has the user already answered for THIS document? Keyed on the content itself — the payload
 * fingerprint for a readable document, the refused version for a `newer` one — so a document
 * that CHANGES after a decline legitimately re-asks (new content is new information), while the
 * same content never nags twice.
 */
/**
 * Has the user answered ANY import question for this mailbox since `since`? The release valve
 * for a hold whose exact fingerprint was never answered: the folder's document can change while
 * the decision is open (the previous organizer writes again), the confirm surface answers the
 * CURRENT content, and a hold keyed to the older fingerprint would otherwise stay frozen until
 * the process re-attaches. Any answer after the hold began means the mailbox's import question
 * is settled — the local store is the ratified truth either way.
 */
export async function profileImportResolutionSince(
  db: Tx, o: { accountId: string; mailboxId: string; since: Date },
): Promise<boolean> {
  const rows = await db.select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, o.accountId),
      eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
      gte(auditLog.createdAt, o.since),
    ))
    .limit(1);
  return rows.length > 0;
}

export async function profileImportResolutionExists(
  db: Tx, o: { accountId: string; mailboxId: string } & ProfileImportSubject,
): Promise<boolean> {
  const subject = "fingerprint" in o
    ? sql`${auditLog.payload}->>'fingerprint' = ${o.fingerprint}`
    // TEXT equality on `v`, deliberately: the version is read off a PUBLIC document, so any
    // JavaScript integer can arrive here, and an `::int` cast overflows PostgreSQL's integer at
    // 2^31 — turning a hostile version number into a 500 on every later candidate or dismissal.
    : sql`${auditLog.payload}->>'fingerprint' is null and ${auditLog.payload}->>'v' = ${String(o.newerV)}`;
  const rows = await db.select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, o.accountId),
      eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
      subject,
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record the user's answer, once. A second identical answer writes nothing — the apply path is
 * idempotent end to end, and a retried decline must not grow the audit table — while a
 * DIFFERENT answer for the same document (declined, then later imported) is a new fact and a
 * new row; the reader above asks "was it answered at all", to which either row says yes.
 *
 * Callable inside the apply transaction, which is the point: the applied sections and the
 * resolution that releases the organizer's hold commit together or not at all.
 */
export async function recordProfileImportResolution(
  db: Tx,
  o: { accountId: string; mailboxId: string; decision: ProfileImportDecision } & ProfileImportSubject,
): Promise<void> {
  const decisionMatch = sql`${auditLog.payload}->>'decision' = ${o.decision}`;
  const subject = "fingerprint" in o
    ? sql`${auditLog.payload}->>'fingerprint' = ${o.fingerprint}`
    // TEXT equality on `v`, deliberately: the version is read off a PUBLIC document, so any
    // JavaScript integer can arrive here, and an `::int` cast overflows PostgreSQL's integer at
    // 2^31 — turning a hostile version number into a 500 on every later candidate or dismissal.
    : sql`${auditLog.payload}->>'fingerprint' is null and ${auditLog.payload}->>'v' = ${String(o.newerV)}`;
  const dupes = await db.select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, o.accountId),
      eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
      subject,
      decisionMatch,
    ))
    .limit(1);
  if (dupes.length > 0) return;
  await db.insert(auditLog).values({
    accountId: o.accountId,
    action: PROFILE_IMPORT_RESOLVED_AUDIT_ACTION,
    payload: {
      mailboxId: o.mailboxId,
      decision: o.decision,
      fingerprint: "fingerprint" in o ? o.fingerprint : null,
      ...("newerV" in o ? { v: o.newerV } : {}),
    },
    inverse: null,
  });
}
