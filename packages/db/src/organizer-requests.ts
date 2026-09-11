import { and, asc, eq, gt, inArray, lt, or } from "drizzle-orm";
import { organizerRequests } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * `organizer_requests` — the READER'S OWN bookkeeping. The mailbox itself (`ohmail/_meta`, via
 * `RequestIo`) is the record the organizer acts on; this table is what the reader's own cycle
 * reads to know which of ITS decisions are still in flight (`schema-mail.ts#organizerRequests`
 * has the four states and why the row is not the record). Every function operates on ONE
 * install's own database and is deliberately unreachable from the organizer's side of a handover:
 * the organizer never queries this table — it reads the folder. In `packages/db` for
 * `learning-signal.ts`'s reason: the worker's reader cycle writes these rows every poll and may
 * not import `@trafficflow/services` at runtime.
 */

/**
 * The closed set the migration's CHECK carries.
 *
 * `refused` joined in mail 0090 and it is the state that made the other four honest. Before it, a
 * reader inferred `applied` from its record's ABSENCE from the mailbox — and an organizer removes
 * a record both when it applies one and when it REFUSES one, so "applied" was being reported for
 * decisions that had been thrown away. The organizer now says which, on a signed ack record, and
 * this is where the answer lands.
 */
export const REQUEST_STATES = ["pending", "sent", "applied", "expired", "refused"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/** A state a row will never leave. What the Screener list may stop excluding a sender for. */
export const TERMINAL_REQUEST_STATES = ["applied", "expired", "refused"] as const;

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
  /** Why the organizer said no. Non-null only in `refused`. A closed vocabulary — see the column. */
  refusedReason: string | null;
  createdAt: Date;
}

function toRow(r: {
  id: string; accountId: string; mailboxId: string; kind: string; payload: unknown;
  decidedAt: Date; state: string; sentAt: Date | null; resolvedAt: Date | null;
  refusedReason: string | null; createdAt: Date;
}): OrganizerRequestRow {
  return {
    id: r.id, accountId: r.accountId, mailboxId: r.mailboxId, kind: r.kind, payload: r.payload,
    decidedAt: r.decidedAt, refusedReason: r.refusedReason,
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

/**
 * How long a refusal is worth showing somebody. A `refused` row is terminal, so without a bound
 * it would ride the Screener list forever — a note about a decision made months ago. It is shown
 * for as long as an outstanding decision could have taken anyway (the same day-long window both
 * sides of the channel use), then goes quiet. Spelled here rather than imported from the worker's
 * `REQUEST_STALE_AFTER_MS`: this package must not depend on `apps/worker`, and the two answer
 * different questions that happen to want the same number — "when does a reader give up waiting"
 * and "when does a refusal stop being news".
 */
export const REFUSAL_VISIBLE_FOR_MS = 24 * 60 * 60 * 1000;

/** One outstanding decision, as the Screener list's exclusion and `pendingDecisions[]` both need it. */
export interface OutstandingMatch {
  id: string;
  scope: "sender" | "domain";
  /** The address (sender scope) or the domain (domain scope) the decision covers, lower-cased. */
  match: string;
  decidedAt: Date;
  /**
   * `pending`/`sent` are still IN FLIGHT — the sender is excluded from the queue because the
   * person has already answered for it. `refused` is NOT: the organizer said no, so the sender
   * comes BACK to the queue and this entry exists only to carry the reason.
   */
  state: "pending" | "sent" | "refused";
  /** What the organizer said no to. Non-null only when `state` is `refused`. */
  refusedReason: string | null;
}

/**
 * Every outstanding decision (`pending` or `sent`) THIS INSTALL has made for one ACCOUNT — what
 * `ScreenerReadService.list` reads to exclude a decided sender and to populate
 * `pendingDecisions[]`. Account-scoped rather than mailbox-scoped: `list`'s query carries no
 * per-row `mailboxId`, and the outstanding set is a handful of rows drained within a cycle or
 * two. An earlier mailbox-scoped sibling had no production caller and was deleted. Rows are
 * visible ONLY on the door that made the decision: this is per-install bookkeeping, so a decision
 * made on a desktop is invisible to Cloud's own `GET /screener` — "the sender leaves the reader's
 * queue immediately" means immediately on THAT door.
 */
export async function listOutstandingForAccount(
  tx: Tx, accountId: string, now?: Date,
): Promise<OutstandingMatch[]> {
  // A RECENT REFUSAL RIDES ALONG, and it is the one member of this set that is NOT outstanding.
  // The caller excludes `pending`/`sent` senders from the queue and must NOT exclude a refused
  // one — the organizer said no, so the person has to see the sender again. It is returned so the
  // reason can be shown beside it rather than the decision simply appearing to have evaporated.
  const refusedSince = new Date((now?.getTime() ?? Date.now()) - REFUSAL_VISIBLE_FOR_MS);
  const rows = await tx.select().from(organizerRequests)
    .where(and(
      eq(organizerRequests.accountId, accountId),
      or(
        eq(organizerRequests.state, "pending"),
        eq(organizerRequests.state, "sent"),
        and(eq(organizerRequests.state, "refused"), gt(organizerRequests.resolvedAt, refusedSince)),
      ),
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
    const state = r.state === "pending" || r.state === "sent" || r.state === "refused" ? r.state : null;
    if (state === null) continue;
    out.push({
      id: r.id, scope, match: match.toLowerCase(), decidedAt: r.decidedAt, state,
      refusedReason: state === "refused" ? r.refusedReason : null,
    });
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

/**
 * `sent` → `applied`: the organizer ACKNOWLEDGED it as applied. Not "its id is no longer in the
 * mailbox", which is what this used to mean and was wrong: a refused record is equally absent, so
 * absence reported success for decisions that were thrown away. The evidence is now a signed ack
 * (`AckRecord`), and this function only records what that ack said. `from` exists for the ROLE
 * FLIP: an install that becomes the organizer settles its own leftover `pending` rows by applying
 * them directly — never `sent`, so they move `pending` → `applied`. Every other caller leaves the
 * default and gets the guarded `sent` → `applied` transition.
 */
export async function markRequestsApplied(
  tx: Tx, ids: readonly string[], resolvedAt: Date,
  opts: { from?: "sent" | "pending" } = {},
): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(organizerRequests)
    .set({ state: "applied", resolvedAt })
    .where(and(
      inArray(organizerRequests.id, [...ids]),
      eq(organizerRequests.state, opts.from ?? "sent"),
    ));
}

/**
 * `sent` → `refused`: the organizer acknowledged it and said no, and this is what it said.
 *
 * The reason is stored so the person can be told something better than "it did not happen" —
 * `pendingDecisions[]` carries it to the client. A `null` reason is a refusal whose named cause
 * this build does not recognise (a newer organizer's vocabulary), which is still a refusal and
 * must still leave the queue.
 */
export async function markRequestsRefused(
  tx: Tx, ids: readonly string[], reason: string | null, resolvedAt: Date,
): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(organizerRequests)
    .set({ state: "refused", resolvedAt, refusedReason: reason })
    .where(and(inArray(organizerRequests.id, [...ids]), eq(organizerRequests.state, "sent")));
}

/**
 * `sent` → `expired`: still in the mailbox past the window. Nobody is organizing.
 *
 * `from` exists for the same reason {@link markRequestsApplied}'s does, and closes a row that
 * would otherwise be IMMORTAL: a `pending` row is one this install could never hand over — it
 * holds no key to sign with, or the append has failed every cycle — and every other expiry
 * predicate requires `sent`, so nothing would ever resolve it and the sender would stay out of the
 * Screener queue for ever.
 */
export async function markRequestsExpired(
  tx: Tx, ids: readonly string[], resolvedAt: Date,
  opts: { from?: "sent" | "pending" } = {},
): Promise<void> {
  if (ids.length === 0) return;
  await tx.update(organizerRequests)
    .set({ state: "expired", resolvedAt })
    .where(and(
      inArray(organizerRequests.id, [...ids]),
      eq(organizerRequests.state, opts.from ?? "sent"),
    ));
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
