import { and, desc, eq, gte, sql } from "drizzle-orm";
import { auditLog } from "./schema-mail.js";
import { auditAction } from "./staff-channels.js";
import type { Tx } from "./change-log.js";

/**
 * The portable profile's import markers — the durable conversation between the organizer that
 * FINDS a travelling settings document and the surface that asks the user about it. The document
 * lives in the mailbox (`ohmail/_meta`); HERE is the bookkeeping around the one decision the
 * organizer refuses to make alone — shall these found settings be applied? — recorded in
 * `audit_log`. Two actions: {@link PROFILE_FOUND_AUDIT_ACTION}, written when the organizer meets
 * a document it will not silently adopt; {@link PROFILE_IMPORT_RESOLVED_AUDIT_ACTION}, written
 * when the user answers, read back to release the hold. On the root barrel: the worker may import
 * core and db only, and this module reaches `schema-mail.js` alone.
 */

/**
 * The `audit_log.action` under which a found foreign profile is recorded — one row per DISTINCT
 * found document, deduplicated by the writer on the document's fingerprint. Payload:
 * `{ mailboxId, state: "found" | "newer", fingerprint, heldForImport, updatedAt?, producer?,
 * counts?, v? }`.
 */
export const PROFILE_FOUND_AUDIT_ACTION = "organizer_profile_found";

/**
 * The `audit_log.action` under which the USER'S ANSWER to a found document is recorded. Payload:
 * `{ mailboxId, fingerprint, decision: "imported" | "declined" | "replaced", v? }` — `fingerprint`
 * names the exact document content answered (null for the `newer` state; `v` carries the refused
 * version). Any answer settles ROUTING. Only `imported` and `replaced` release WRITE-BEHIND
 * ({@link profileImportWriteReleased}): a decline keeps the document in the mailbox, because it
 * is the only copy there of the other install's settings.
 */
export const PROFILE_IMPORT_RESOLVED_AUDIT_ACTION = "organizer_profile_import_resolved";

/**
 * The `audit_log.action` under which an organizer records, BEFORE it appends, the write second of a
 * settings copy it is about to write (and the second of a copy a build that records nothing wrote under
 * its id, once it has judged that copy its own). Payload: `{ mailboxId, installId, second, version }`,
 * `version` the recording build's. A copy under this install's id is this store's own only at a second
 * it recorded: a store restored from a backup has no record of what its later life wrote. A copy's
 * record is written again every 30 days while the copy is in the mailbox, so the audit log's age-out
 * never takes the record of a copy still there.
 */
export const PROFILE_WRITTEN_AUDIT_ACTION = "organizer_profile_written";

/**
 * Record a second this store vouches for, before the append it covers; `at` is the organizer's clock,
 * the one its age-out and renewal read. Throws when the database refuses.
 */
export async function recordProfileWrite(
  db: Tx, o: { accountId: string; mailboxId: string; installId: string; second: number; version: string; at?: Date },
): Promise<void> {
  await db.insert(auditLog).values({
    accountId: o.accountId,
    action: auditAction(PROFILE_WRITTEN_AUDIT_ACTION),
    payload: { mailboxId: o.mailboxId, installId: o.installId, second: o.second, version: o.version },
    inverse: null,
    ...(o.at === undefined ? {} : { createdAt: o.at }),
  });
}

/**
 * The `audit_log.action` under which an organizer records whether the mailbox keeps its settings copy, so a
 * surface without the organizer's process (Cloud Settings) can say so. Payload: `{ mailboxId, kept, code }`,
 * `code` the refusal's own literal (`profile_append_unreadable`) or null. Written on a change only, and the
 * standing refusal again once {@link PROFILE_COPY_RENEW_MS} old so the age-out never takes it.
 */
export const PROFILE_COPY_AUDIT_ACTION = "organizer_profile_copy";

/** How old a standing "not kept" record grows before it is written again. */
export const PROFILE_COPY_RENEW_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether the mailbox keeps the organizer's settings copy, as the organizer last recorded it. */
export interface ProfileCopyState { kept: boolean; code: string | null }

async function newestProfileCopy(
  db: Tx, accountId: string, mailboxId: string,
): Promise<(ProfileCopyState & { at: number }) | null> {
  const [row] = await db.select({ payload: auditLog.payload, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, accountId),
      eq(auditLog.action, PROFILE_COPY_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${mailboxId}`,
    ))
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  const p = row?.payload as { kept?: unknown; code?: unknown } | null | undefined;
  if (!p || typeof p.kept !== "boolean") return null;
  const at = new Date(row!.createdAt as unknown as string | number | Date).getTime();
  return { kept: p.kept, code: typeof p.code === "string" ? p.code : null, at: Number.isFinite(at) ? at : 0 };
}

/** The newest copy record for the mailbox, or null when its organizer never recorded one. */
export async function latestProfileCopy(db: Tx, accountId: string, mailboxId: string): Promise<ProfileCopyState | null> {
  const r = await newestProfileCopy(db, accountId, mailboxId);
  return r === null ? null : { kept: r.kept, code: r.code };
}

/**
 * Record whether the mailbox keeps the copy. A kept copy is recorded only over a standing "not kept" (a mailbox
 * that never failed writes nothing); a refusal only when it is new, names another code, or is due a renewal.
 */
export async function recordProfileCopy(
  db: Tx, o: { accountId: string; mailboxId: string; kept: boolean; code: string | null; at?: Date },
): Promise<void> {
  const latest = await newestProfileCopy(db, o.accountId, o.mailboxId);
  if (o.kept && (latest === null || latest.kept)) return;
  const at = (o.at ?? new Date()).getTime();
  if (!o.kept && latest !== null && !latest.kept && latest.code === o.code && at - latest.at < PROFILE_COPY_RENEW_MS) return;
  await db.insert(auditLog).values({
    accountId: o.accountId,
    action: auditAction(PROFILE_COPY_AUDIT_ACTION),
    payload: { mailboxId: o.mailboxId, kept: o.kept, code: o.kept ? null : o.code },
    inverse: null,
    ...(o.at === undefined ? {} : { createdAt: o.at }),
  });
}

/**
 * The seconds this store recorded for the mailbox under this install id, each with the time of its
 * newest record (epoch milliseconds). Every record, not the newest few: a mailbox whose removals do not
 * stick keeps more of the store's copies than that. The audit log's one-year age-out bounds the read.
 */
export async function profileWritesRecorded(
  db: Tx, o: { accountId: string; mailboxId: string; installId: string },
): Promise<Map<number, number>> {
  const rows = await db.select({ payload: auditLog.payload, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, o.accountId),
      eq(auditLog.action, PROFILE_WRITTEN_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
      sql`${auditLog.payload}->>'installId' = ${o.installId}`,
    ))
    .orderBy(desc(auditLog.createdAt));
  const seconds = new Map<number, number>();
  for (const r of rows) {
    const p = r.payload as { second?: unknown; ours?: unknown } | null;
    if (typeof p?.second !== "number" || !Number.isFinite(p.second) || p.ours === false) continue;
    const at = new Date(r.createdAt as unknown as string | number | Date).getTime();
    if (!seconds.has(p.second)) seconds.set(p.second, Number.isFinite(at) ? at : 0);
  }
  return seconds;
}

/**
 * `replaced` is the explicit "save this ohmail's settings to the mailbox": nothing is applied, and
 * the organizer may now overwrite the answered document.
 */
export type ProfileImportDecision = "imported" | "declined" | "replaced";

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
  /** `found` only: the install that wrote it — with `updatedAt`, where the import re-reads it. */
  installId?: string;
  producer?: { kind: string; version: string };
  counts?: {
    screener: number; rules: number; notifyRules: number; tagNames: number; awayResponder: number;
    /** 1 when the document carries a signature; absent on a marker an older organizer wrote. */
    signature?: number;
  };
  /** `found` only: the document's signature's receipt (`signatureReceipt`), when it carries one. */
  signatureReceipt?: string;
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
  /**
   * Lapse subjects seen while walking newest→oldest; a held marker matching one is closed. A
   * same-subject re-ask closed by a stale lapse is the accepted residual: a document that
   * vanished and reappeared byte-identically across a handoff, with the old process's lapse
   * landing after the successor's marker, reads as closed. It SELF-HEALS — the successor's
   * in-memory hold keeps routing safe, and the next preflight re-arms and writes a fresh held
   * marker, which stands (the dedup compares against the LATEST row, and that row is the lapse).
   * Marker generations would close the window at the cost of a second identity scheme in a table
   * read by three surfaces; the bounded, self-healing residual is the better trade.
   */
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
      ...(typeof p.installId === "string" ? { installId: p.installId } : {}),
      ...(p.producer && typeof p.producer === "object" ? { producer: p.producer as { kind: string; version: string } } : {}),
      ...(p.counts && typeof p.counts === "object" ? { counts: p.counts as ProfileFoundMarker["counts"] } : {}),
      ...(typeof p.signatureReceipt === "string" ? { signatureReceipt: p.signatureReceipt } : {}),
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
    // CAST TO TEXT on the left: the device store's `->>` answers a JSON number as an INTEGER,
    // which never equals a TEXT, so a phone's newer-format "Not now" was never read back.
    : sql`${auditLog.payload}->>'fingerprint' is null and cast(${auditLog.payload}->>'v' as text) = ${String(o.newerV)}`;
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
 * MAY THE ORGANIZER OVERWRITE THIS DOCUMENT? Only after an import or an explicit replace. Routing
 * asks {@link profileImportResolutionExists} instead, where a decline counts. The decisions are a
 * LITERAL list: drizzle flattens a bound array in a raw fragment, and `->>` is the form the SQLite
 * twin already runs. Fingerprint only — a newer-format document is never written over.
 */
export async function profileImportWriteReleased(
  db: Tx, o: { accountId: string; mailboxId: string; fingerprint: string },
): Promise<boolean> {
  const rows = await db.select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, o.accountId),
      eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
      sql`${auditLog.payload}->>'fingerprint' = ${o.fingerprint}`,
      sql`${auditLog.payload}->>'decision' in ('imported', 'replaced')`,
    ))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record the user's answer, once. A second identical answer writes nothing — the apply path is
 * idempotent end to end, and a retried decline must not grow the audit table — while a
 * DIFFERENT answer for the same document (declined, then later imported) is a new fact and a
 * new row; `profileImportResolutionExists` asks "was it answered at all", to which either row says
 * yes, and a declined-then-replaced document carries both rows.
 *
 * Callable inside the apply transaction, which is the point: the applied sections and the
 * resolution that releases the organizer's hold commit together or not at all.
 */
export async function recordProfileImportResolution(
  db: Tx,
  o: { accountId: string; mailboxId: string; decision: ProfileImportDecision; result?: ProfileImportResult }
    & ProfileImportSubject,
): Promise<void> {
  const decisionMatch = sql`${auditLog.payload}->>'decision' = ${o.decision}`;
  const subject = "fingerprint" in o
    ? sql`${auditLog.payload}->>'fingerprint' = ${o.fingerprint}`
    // TEXT equality on `v`, deliberately: the version is read off a PUBLIC document, so any
    // JavaScript integer can arrive here, and an `::int` cast overflows PostgreSQL's integer at
    // 2^31 — turning a hostile version number into a 500 on every later candidate or dismissal.
    // CAST TO TEXT on the left: the device store's `->>` answers a JSON number as an INTEGER,
    // which never equals a TEXT, so a phone's newer-format "Not now" was never read back.
    : sql`${auditLog.payload}->>'fingerprint' is null and cast(${auditLog.payload}->>'v' as text) = ${String(o.newerV)}`;
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
    action: auditAction(PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
    payload: {
      mailboxId: o.mailboxId,
      decision: o.decision,
      fingerprint: "fingerprint" in o ? o.fingerprint : null,
      ...("newerV" in o ? { v: o.newerV } : {}),
      ...(o.result === undefined ? {} : { result: o.result }),
    },
    inverse: null,
  });
}

/** What an import ARRIVED with, carried on its `imported` resolution for the card to read back. */
export interface ProfileImportResult {
  imported: {
    screener: number; rules: number; notifyRules: number; tags: number; awayResponder: boolean; signature?: boolean;
    signatureKept?: boolean;
  };
  skippedRules: number;
  /** Local rule rows the import retired (`applyOrganizerProfile`); absent from an older row. */
  retiredRules?: number;
}

/**
 * The result recorded with the `imported` answer for this exact document, or null — none
 * recorded (an older row) or not imported. Read once, when a handed-over press finished.
 */
export async function profileImportResult(
  db: Tx, o: { accountId: string; mailboxId: string; fingerprint: string },
): Promise<ProfileImportResult | null> {
  const [row] = await db.select({ payload: auditLog.payload })
    .from(auditLog)
    .where(and(
      eq(auditLog.accountId, o.accountId),
      eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
      sql`${auditLog.payload}->>'mailboxId' = ${o.mailboxId}`,
      sql`${auditLog.payload}->>'fingerprint' = ${o.fingerprint}`,
      sql`${auditLog.payload}->>'decision' = 'imported'`,
    ))
    .limit(1);
  const r = (row?.payload as { result?: ProfileImportResult } | null | undefined)?.result;
  return r && typeof r === "object" && typeof r.imported === "object" && r.imported !== null ? r : null;
}
