import { and, eq, ne } from "drizzle-orm";
import {
  listProfileRequestsNaming, mailboxes, REFUSAL_VISIBLE_FOR_MS, type OrganizerRequestRow, type Tx,
} from "@trafficflow/db";

/**
 * WHERE A SETTINGS CHANGE MADE ON A READER WENT — the read a settings pane says its sentence from.
 *
 * On an install that organizes none of the account's live mailboxes, a change to a travelling
 * setting is a `profile.update` per holding install, and the reader's own row is never written.
 * The pane used to say "Saved." at the press and nothing after, so an applied change and one the
 * holder turned away read the same. The state is the NEWEST request per live mailbox: `asked`
 * while any is unanswered, `refused` when one said no within the refusal window, `applied` when
 * every one did. `null` on an install that organizes a mailbox, and when there is nothing to say.
 */
export interface ProfileChangeWire {
  state: "asked" | "applied" | "refused";
  /** The holder that refused, by the name it recorded; `null` otherwise or when it recorded none. */
  holder: string | null;
  /** `unreadable`: the holder's build could not read the change. `other`: it turned it away. */
  refusal: "unreadable" | "other" | null;
}

/** The refusals that mean the holder's build could not read the record, and an unnamed one. */
const UNREADABLE: ReadonlySet<string | null> = new Set([null, "invalid_payload", "unhandled_kind", "malformed"]);

export interface ProfileChangeReading {
  change: ProfileChangeWire | null;
  /**
   * The sub-keys of `field` the holders last APPLIED, newest per key — the values a reader shows,
   * because its own row is never written. Empty on an install that organizes a mailbox.
   */
  applied: Record<string, unknown>;
}

/** A payload member as an object of sub-keys; the legacy posture string reads as `{ ohboxPolicy }`. */
function membersOf(field: string, row: OrganizerRequestRow): Record<string, unknown> | null {
  const v = (row.payload as Record<string, unknown>)[field];
  if (field === "screeningPreference" && (v === null || typeof v === "string")) return { ohboxPolicy: v };
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The answer the newest request per mailbox gives, or `null` when there is nothing to say. */
function stateOf(
  latest: readonly OrganizerRequestRow[], nameOf: ReadonlyMap<string, string | null>, now: Date,
): ProfileChangeWire | null {
  if (latest.length === 0) return null;
  if (latest.some((r) => r.state === "pending" || r.state === "sent")) {
    return { state: "asked", holder: null, refusal: null };
  }
  const since = now.getTime() - REFUSAL_VISIBLE_FOR_MS;
  const refused = latest.find((r) => r.state === "refused" && (r.resolvedAt?.getTime() ?? 0) > since);
  if (refused) {
    return {
      state: "refused",
      holder: nameOf.get(refused.mailboxId) ?? null,
      refusal: UNREADABLE.has(refused.refusedReason) ? "unreadable" : "other",
    };
  }
  if (latest.every((r) => r.state === "applied")) return { state: "applied", holder: null, refusal: null };
  return null;
}

async function liveMailboxes(db: Tx, accountId: string) {
  return db.select({
    id: mailboxes.id, role: mailboxes.organizerRole, name: mailboxes.organizedByName,
  }).from(mailboxes).where(and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled")));
}

/** Newest first per mailbox, over the rows naming any of `fields`. */
function newestPerMailbox(rows: readonly OrganizerRequestRow[]): Map<string, OrganizerRequestRow> {
  const newest = new Map<string, OrganizerRequestRow>();
  for (const r of rows) if (!newest.has(r.mailboxId)) newest.set(r.mailboxId, r);
  return newest;
}

/**
 * An ACCOUNT-scoped setting — the Screening preference, the away responder, the dormancy window.
 * `applied` is filled for the first field only, from the requests holders acknowledged.
 */
export async function readProfileChange(
  db: Tx, accountId: string, field: string | readonly string[], now: Date,
): Promise<ProfileChangeReading> {
  const fields = typeof field === "string" ? [field] : field;
  const live = await liveMailboxes(db, accountId);
  if (live.length === 0 || live.some((m) => m.role === "organizer")) return { change: null, applied: {} };
  const nameOf = new Map(live.map((m) => [m.id, m.name ?? null]));

  const rows = (await listProfileRequestsNaming(db, accountId, fields)).filter((r) => nameOf.has(r.mailboxId));

  const applied: Record<string, unknown> = {};
  for (const r of rows) {
    if (r.state !== "applied") continue;
    for (const [k, v] of Object.entries(membersOf(fields[0]!, r) ?? {})) if (!(k in applied)) applied[k] = v;
  }
  return { change: stateOf([...newestPerMailbox(rows).values()], nameOf, now), applied };
}

/**
 * A PER-MAILBOX setting — the signature. Each mailbox this install does not organize answers
 * on its own: a mixed account still sends a signature to that mailbox's holder alone.
 */
export async function readMailboxProfileChanges(
  db: Tx, accountId: string, fields: readonly string[], now: Date,
): Promise<Record<string, ProfileChangeWire>> {
  const live = (await liveMailboxes(db, accountId)).filter((m) => m.role !== "organizer");
  if (live.length === 0) return {};
  const nameOf = new Map(live.map((m) => [m.id, m.name ?? null]));
  const rows = (await listProfileRequestsNaming(db, accountId, fields)).filter((r) => nameOf.has(r.mailboxId));
  const out: Record<string, ProfileChangeWire> = {};
  for (const [mailboxId, row] of newestPerMailbox(rows)) {
    const change = stateOf([row], nameOf, now);
    if (change) out[mailboxId] = change;
  }
  return out;
}
