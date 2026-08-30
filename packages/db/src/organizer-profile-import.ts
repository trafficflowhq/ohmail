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
  // A short window, newest first: a `lapsed` row closes ONLY the marker it names (see the
  // organizer's `MarkerFact`), so the read may need to look past a stale lapse to the held
  // marker a successor process wrote just before it. Five rows bounds the walk generously —
  // markers are deduplicated per distinct fact, so consecutive rows are distinct facts.
  const rows = await db.select({ payload: auditLog.payload })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, accountId),
      eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${mailboxId}`,
    ))
    .orderBy(desc(auditLog.createdAt))
    .limit(5);
  const shape = (raw: unknown): ({ mailboxId: string; state: string } & Partial<Omit<ProfileFoundMarker, "state">> & { v?: unknown }) | null => {
    const p = raw as ({ mailboxId?: unknown; state?: unknown } & Partial<Omit<ProfileFoundMarker, "state">>) | null;
    return p && typeof p.mailboxId === "string" && typeof p.state === "string"
      ? (p as { mailboxId: string; state: string } & Partial<Omit<ProfileFoundMarker, "state">>)
      : null;
  };
  /** Lapse subjects seen while walking newest→oldest; a held marker matching one is closed.
   *
   * A SAME-SUBJECT re-ask closed by a stale lapse is the accepted residual here (review round
   * 12 raised the generation question, round 13 pressed it): a document that vanished and
   * reappeared BYTE-IDENTICALLY across a handoff, with the old process's lapse landing after
   * the successor's marker, reads as closed. It SELF-HEALS: the successor's in-memory hold
   * keeps routing safe regardless, and the next preflight of any organizer re-arms and writes
   * a fresh held marker — which, arriving after the lapse, stands (the dedup compares against
   * the LATEST row, and that row is the lapse). Marker generations would close the window at
   * the cost of a second identity scheme in a table read by three surfaces; the bounded,
   * self-healing residual is the better trade. */
  const lapsedFingerprints = new Set<string>();
  const lapsedVersions = new Set<number>();
  for (const row of rows) {
    const p = shape(row.payload);
    if (!p) return null;
    if (p.state === "lapsed") {
      if (typeof p.fingerprint === "string") lapsedFingerprints.add(p.fingerprint);
      if (typeof (p as { v?: unknown }).v === "number") lapsedVersions.add((p as { v: number }).v);
      // A legacy lapse with NO subject (rows written before the subject rode along) closes
      // whatever came before it — the old reading, kept so existing rows keep their meaning.
      if (p.fingerprint == null && (p as { v?: unknown }).v == null) return null;
      continue;
    }
    if (p.state !== "found" && p.state !== "newer") return null;
    const closed =
      (p.state === "found" && typeof p.fingerprint === "string" && lapsedFingerprints.has(p.fingerprint))
      || (p.state === "newer" && typeof (p as { v?: unknown }).v === "number"
        && lapsedVersions.has((p as { v: number }).v));
    if (closed) return null;
    return {
      mailboxId: p.mailboxId as string,
      state: p.state,
      fingerprint: typeof p.fingerprint === "string" ? p.fingerprint : null,
      heldForImport: p.heldForImport === true,
      ...(typeof (p as { v?: unknown }).v === "number" ? { v: (p as { v: number }).v } : {}),
      ...(typeof p.updatedAt === "string" ? { updatedAt: p.updatedAt } : {}),
      ...(p.producer && typeof p.producer === "object" ? { producer: p.producer as { kind: string; version: string } } : {}),
      ...(p.counts && typeof p.counts === "object" ? { counts: p.counts as ProfileFoundMarker["counts"] } : {}),
    };
  }
  return null;
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
 * Has the user answered ANY import question for this mailbox since `since`?
 *
 * NO LONGER a release valve for the organizer's hold (2026-08-30): the hold now re-derives its
 * subject from the folder (`profile.ts#reholdFromFolder`), and a mailbox-wide valve let a STALE
 * answer to a superseded document release a re-armed hold on the document that replaced it.
 * Kept as a generic query for surfaces that ask the coarse question ("has this mailbox's import
 * conversation had any answer lately"), with no hold semantics attached.
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
