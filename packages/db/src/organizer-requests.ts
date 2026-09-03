import { and, asc, eq, inArray, lt, or } from "drizzle-orm";
import { organizerRequests } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `organizer_requests` — THE READER'S OWN BOOKKEEPING (0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The mailbox itself (`ohmail/_meta`, via `RequestIo`) is the record the organizer acts on. This
 * table is what the READER's own cycle reads to know which of ITS decisions are still in flight —
 * see `schema-mail.ts#organizerRequests`'s own header for the four states and why the row is not
 * the record. Every function here operates on ONE install's own database and is deliberately
 * unreachable from the organizer's side of a handover: the organizer never queries this table, it
 * only ever reads the folder (`apps/worker/src/request-drain.ts`).
 *
 * In `packages/db` rather than `packages/services` for `learning-signal.ts`'s reason: the worker's
 * reader cycle (`apps/worker/src/request-drain.ts`) writes these rows every poll and may not
 * import `@trafficflow/services` at runtime.
 */

/** The closed set the migration's CHECK carries. */
export const REQUEST_STATES = ["pending", "sent", "applied", "expired"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export interface OrganizerRequestRow {
  id: string;
  accountId: string;
  mailboxId: string;
  kind: string;
  payload: unknown;
  decidedAt: Date;
  state: RequestState;
  sentAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

function toRow(r: {
  id: string; accountId: string; mailboxId: string; kind: string; payload: unknown;
  decidedAt: Date; state: string; sentAt: Date | null; resolvedAt: Date | null; createdAt: Date;
}): OrganizerRequestRow {
  return {
    id: r.id, accountId: r.accountId, mailboxId: r.mailboxId, kind: r.kind, payload: r.payload,
    decidedAt: r.decidedAt,
    // Coerced, never trusted — the column is NOT NULL with a CHECK behind it, so an unrecognised
    // value is unreachable from this tree, and the direction it must fail in if it ever happens is
    // the one that gets a HUMAN looked at again rather than silently vanished: `pending` is where
    // every row starts, so the reader's cycle re-tries the append rather than forgetting the row.
    state: (REQUEST_STATES as readonly string[]).includes(r.state) ? (r.state as RequestState) : "pending",
    sentAt: r.sentAt, resolvedAt: r.resolvedAt, createdAt: r.createdAt,
  };
}

/**
 * WRITE ONE — the reader's own door creating a request. `id` is caller-supplied (not
 * `defaultRandom()`'s auto-generation) because it doubles as the `X-Ohmail-Request-Id` the
 * mailbox record carries: "the two identities are one" (the table's own header). The caller mints
 * it before this insert and reuses it when it formats the wire record.
 */
export async function insertOrganizerRequest(tx: Tx, input: {
  id: string; accountId: string; mailboxId: string; kind: string; payload: unknown; decidedAt: Date;
}): Promise<OrganizerRequestRow> {
  const [row] = await tx.insert(organizerRequests).values({
    id: input.id, accountId: input.accountId, mailboxId: input.mailboxId, kind: input.kind,
    payload: input.payload, decidedAt: input.decidedAt, state: "pending",
  }).returning();
  return toRow(row!);
}

/**
 * Every `pending` request on one mailbox, oldest first — what the reader's cycle appends next.
 * `decidedAt` then `id`: two decisions made in the same instant (a fast double-press, or a client
 * clock with second resolution) still land in a STABLE order across repeated reads, which matters
 * because `apps/worker/src/request-drain.ts` — the organizer's OWN read of the analogous folder
 * records — sorts by that same pair for the identical reason (its own header: "two doors deciding
 * one sender in one cycle land in the order the human made them").
 */
export async function listPendingRequests(tx: Tx, mailboxId: string): Promise<OrganizerRequestRow[]> {
  const rows = await tx.select().from(organizerRequests)
    .where(and(eq(organizerRequests.mailboxId, mailboxId), eq(organizerRequests.state, "pending")))
    .orderBy(asc(organizerRequests.decidedAt), asc(organizerRequests.id));
  return rows.map(toRow);
}

/** Every `sent` request on one mailbox — what the reader's cycle checks for presence/absence. */
export async function listSentRequests(tx: Tx, mailboxId: string): Promise<OrganizerRequestRow[]> {
  const rows = await tx.select().from(organizerRequests)
    .where(and(eq(organizerRequests.mailboxId, mailboxId), eq(organizerRequests.state, "sent")));
  return rows.map(toRow);
}

/** One outstanding decision, as the Screener list's exclusion and `pendingDecisions[]` both need it. */
export interface OutstandingMatch {
  id: string;
  scope: "sender" | "domain";
  /** The address (sender scope) or the domain (domain scope) the decision covers, lower-cased. */
  match: string;
  decidedAt: Date;
  state: "pending" | "sent";
}

/**
 * Every outstanding decision (`pending` or `sent`) THIS INSTALL has made for one ACCOUNT, across
 * all of its mailboxes — what `ScreenerReadService.list` reads to exclude a decided sender from
 * the queue and to populate `pendingDecisions[]`.
 *
 * Account-scoped rather than mailbox-scoped: `list`'s own query (`heldSenderPage`) does not carry
 * `mailboxId` per row, and the account is small enough (a handful of in-flight decisions at most —
 * this table is drained within a cycle or two of being written) that reading the whole account's
 * outstanding set costs nothing extra. An earlier mailbox-scoped, match-filtered sibling
 * (`listOutstandingByMatch`, a `payload->>'match'` JSONB lookup) had no production caller — this
 * function was always the one `ScreenerReadService.list` actually reaches for — and was deleted
 * rather than kept as a second, untested way to ask the same table the same question.
 *
 * **Rows here are visible ONLY on the door that made the decision.** `organizer_requests` is
 * per-install bookkeeping (the table's own header): if this account's mailbox is organized by
 * Cloud and the decision was made on a desktop, Cloud's OWN `GET /screener` sees no row for it at
 * all — its query runs against a different database. The exclusion is therefore a property of
 * "the Screener you are looking at from the same install you decided on," which is what "the
 * sender leaves the reader's queue immediately" means in the ruling: immediately on THAT door.
 */
export async function listOutstandingForAccount(tx: Tx, accountId: string): Promise<OutstandingMatch[]> {
  const rows = await tx.select().from(organizerRequests)
    .where(and(
      eq(organizerRequests.accountId, accountId),
      or(eq(organizerRequests.state, "pending"), eq(organizerRequests.state, "sent")),
    ));
  const out: OutstandingMatch[] = [];
  for (const r of rows) {
    // Defensive: this table's rows are all written by THIS install's own
    // `ScreenerService.requestAsReader`, which always writes `{scope, match, ...}` — but a row
    // whose shape does not parse is skipped rather than crashing the whole list, on the same
    // fail-safe direction `validateRequestPayload` takes for the drain's own untrusted read.
    const p = r.payload as { scope?: unknown; match?: unknown } | null;
    const scope = p?.scope;
    const match = p?.match;
    if ((scope !== "sender" && scope !== "domain") || typeof match !== "string" || match === "") continue;
    const state = r.state === "pending" || r.state === "sent" ? r.state : null;
    if (state === null) continue;
    out.push({ id: r.id, scope, match: match.toLowerCase(), decidedAt: r.decidedAt, state });
  }
  return out;
}

/** `pending` → `sent`: the reader's cycle appended it to the mailbox. */
export async function markRequestsSent(tx: Tx, ids: readonly string[], sentAt: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(organizerRequests)
    .set({ state: "sent", sentAt })
    .where(and(inArray(organizerRequests.id, [...ids]), eq(organizerRequests.state, "pending")));
}

/** `sent` → `applied`: its id is no longer in the mailbox, so the organizer took it. */
export async function markRequestsApplied(tx: Tx, ids: readonly string[], resolvedAt: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(organizerRequests)
    .set({ state: "applied", resolvedAt })
    .where(and(inArray(organizerRequests.id, [...ids]), eq(organizerRequests.state, "sent")));
}

/** `sent` → `expired`: still in the mailbox past the window. Nobody is organizing. */
export async function markRequestsExpired(tx: Tx, ids: readonly string[], resolvedAt: Date): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(organizerRequests)
    .set({ state: "expired", resolvedAt })
    .where(and(inArray(organizerRequests.id, [...ids]), eq(organizerRequests.state, "sent")));
}

/**
 * `sent` rows older than `olderThan`, on one mailbox — the candidates for expiry. Read separately
 * from {@link listSentRequests} so the reader's cycle can tell "still present, still within the
 * window" (wait) from "still present, past the window" (expire) without two round trips through
 * the same predicate written twice.
 */
export async function listStaleSentRequests(
  tx: Tx, mailboxId: string, olderThan: Date,
): Promise<OrganizerRequestRow[]> {
  const rows = await tx.select().from(organizerRequests)
    .where(and(
      eq(organizerRequests.mailboxId, mailboxId),
      eq(organizerRequests.state, "sent"),
      lt(organizerRequests.sentAt, olderThan),
    ));
  return rows.map(toRow);
}
