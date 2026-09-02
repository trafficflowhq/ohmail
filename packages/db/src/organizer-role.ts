import { and, eq, isNotNull, ne } from "drizzle-orm";
import { mailboxes } from "./schema-mail.js";
import type { Tx } from "./change-log.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ORGANIZING ROLE, AND THE ONE REFUSAL EVERY WRITE DOOR SHARES (mail 0083)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Exactly one active organizer per mailbox is the invariant the product rests on. What changed
 * with mail 0083 is what the LOSER does: it used to stop entirely (`status='disabled'` plus an
 * `organized_elsewhere:*` reason, off the roster, frozen mirror). It is now A READER — another
 * mail client on the same mailbox.
 *
 * ── WHAT A READER MAY DO, AND THE ONE IMAP VERB IT WRITES ─────────────────────────────────
 *
 * MAY: read, search its own mirror, mark mail read (`\Seen`, executed by `reconcileFlags`, which
 * is already a separate pass from `reconcileFolders`), send now, and draft with AI on its own
 * door. Those are exactly the things any mail client on the mailbox does, and none of them
 * contends with the organizer: `\Seen` is per-message state the IMAP server itself arbitrates,
 * and a send appends to Sent.
 *
 * MAY NOT: screener decide/suggest, rules, move, delete (v1), triage, tags-assign, schedule,
 * unsubscribe, junk sweep/rescue, resync, profile publish. Every one of those either MOVES mail,
 * changes the organizer's own store in a way the organizer would then fight, or mints an
 * appointment a demotion would have to cancel.
 *
 * **Delete is on the refused list even though it is not a folder move, and that is a v1
 * decision rather than an oversight**: one IMAP write verb (`setFlags`) keeps the reader's
 * surface auditable, and a delete is a `\Deleted` + EXPUNGE against mail another install is
 * organizing. It is a named follow-up, not a permanent rule.
 *
 * ── WHY THE HELPER IS HERE AND NOT IN `packages/services` ─────────────────────────────────
 *
 * `stand-down-sends.ts`'s reason, verbatim: this is one sentence with several callers, the
 * worker may not import `@trafficflow/services` at runtime (its barrel drags an HTML sanitiser
 * into the worker's boot graph, a hard `ERR_REQUIRE_CYCLE_MODULE` on Node 23), and two spellings
 * of "somebody else organizes this mailbox" would be two answers to what the person is told.
 * This module reaches `schema-mail.js` and `change-log.js` alone, which keeps it inside the
 * desktop engine's closure rule (`index.ts`'s barrel header).
 *
 * ── THE POSITIVE CENSUS IS THE GUARD, NOT THIS COMMENT ────────────────────────────────────
 *
 * A refusal helper is only worth what its call sites are, and "every write site calls it" is not
 * a property a reader can check by reading. So the invariant is pinned as a CENSUS: the exact set
 * of write doors that call this is asserted, in both directions, so adding a door without a
 * decision about the reader fails — and so does silently dropping a refusal from one. The failure
 * being guarded is not a door that stopped refusing; it is the door somebody adds without having
 * asked the question.
 */

/** The two roles. Closed by `mailboxes_organizer_role_closed`; the column is NOT NULL. */
export const ORGANIZER_ROLES = ["organizer", "reader"] as const;
export type OrganizerRole = (typeof ORGANIZER_ROLES)[number];

export function isOrganizerRole(v: unknown): v is OrganizerRole {
  return typeof v === "string" && (ORGANIZER_ROLES as readonly string[]).includes(v);
}

/**
 * The three organizer kinds — the same closed set `disabled_reason`'s suffix carries, and
 * `'unknown'` is what makes it closed rather than merely small (a peer this build cannot rank).
 * Closed by `mailboxes_organized_by_kind_closed`.
 */
export const ORGANIZER_KINDS = ["cloud", "local", "unknown"] as const;
export type OrganizerKind = (typeof ORGANIZER_KINDS)[number];

export function isOrganizerKind(v: unknown): v is OrganizerKind {
  return typeof v === "string" && (ORGANIZER_KINDS as readonly string[]).includes(v);
}

/** The lease's occupancy as a reader cycle last saw it. Closed by `mailboxes_organizer_state_closed`. */
export const ORGANIZER_STATES = ["held", "stopped"] as const;
export type OrganizerState = (typeof ORGANIZER_STATES)[number];

export function isOrganizerState(v: unknown): v is OrganizerState {
  return typeof v === "string" && (ORGANIZER_STATES as readonly string[]).includes(v);
}

/**
 * THE CAP ON A CUSTOMER'S MACHINE NAME, applied at the single write site.
 *
 * `organized_by_name` is `X-Ohmail-Display-Name` off another install's claim — a string that
 * install chose, which on a desktop is a hostname somebody typed. It gets no CHECK, because free
 * text closes no set and a byte bound in the database answers 23514 to a person who named their
 * laptop; it gets a bound HERE instead, exactly as `MAILBOX_SIGNATURE_MAX_CHARS` does.
 *
 * 120 is generous for a hostname and short enough that the value cannot become a payload. It is
 * paired with {@link organizerDisplayName}, which also strips CR/LF: the value arrives out of an
 * RFC822 header and goes back into one on the next claim, so a name carrying a newline could
 * inject a header field. `organizer-lease.ts#headerSafe` does the same strip on the way out; this
 * is the same rule applied on the way IN, so a malformed claim cannot reach the column at all.
 */
export const ORGANIZED_BY_NAME_MAX = 120;

/** Header-safe and bounded. Empty (and whitespace-only) becomes null — "the claim did not say". */
export function organizerDisplayName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const flat = raw.replace(/[\r\n]+/g, " ").trim();
  if (flat === "") return null;
  return flat.slice(0, ORGANIZED_BY_NAME_MAX);
}

/**
 * WHO ORGANIZES THIS MAILBOX, as every refusal reports it and every banner renders it.
 *
 * The three fields are the three a sentence needs — "Organized by ohmail Cloud since Tuesday" —
 * and every one of them is nullable because a claim can be malformed, a backfilled row has no
 * observation behind it, and a mailbox may be organized by something this build cannot rank.
 */
export interface OrganizedBy {
  kind: OrganizerKind | null;
  name: string | null;
  since: string | null;
}

/**
 * The refusal. `409 organized_elsewhere`, carrying `{ by: { kind, name, since } }` so every door
 * composes ONE sentence rather than eleven.
 *
 * ── WHY IT IS NOT A `ServiceError` ────────────────────────────────────────────────────────
 *
 * It is thrown from `@trafficflow/db`, which cannot import `@trafficflow/services` (the
 * dependency runs the other way) — and it must be thrown from there for the reason the module
 * header gives. It carries the SAME four fields `ServiceError` does, and
 * `packages/api/src/middleware.ts#withErrorEnvelope` maps it in its own arm beside that class,
 * so every route answers the envelope contract without a per-route catch.
 *
 * `retryable` is deliberately absent, i.e. `undefined`: retrying changes nothing until a human
 * takes the mailbox back, and a `retryable: false` would be a claim about permanence that a
 * claim-back falsifies in one cycle.
 */
export class OrganizedElsewhereError extends Error {
  readonly code = "organized_elsewhere";
  readonly httpStatus = 409;
  readonly details: { by: OrganizedBy };
  constructor(readonly mailboxId: string, by: OrganizedBy) {
    super(
      "another install is organizing this mailbox, so this one is a reader: it mirrors the "
      + "mailbox and can mark mail read and send, but it does not move, file or delete mail. "
      + "Choose to organize here instead if you want this install to take it over.",
    );
    this.name = "OrganizedElsewhereError";
    this.details = { by };
  }
}

/** A mailbox the caller's account does not hold. Distinct from the refusal above on purpose. */
export class MailboxNotFoundError extends Error {
  readonly code = "not_found";
  readonly httpStatus = 404;
  constructor(readonly mailboxId: string) {
    super("no such mailbox");
    this.name = "MailboxNotFoundError";
  }
}

/** The row as both readers below want it. */
export interface OrganizerRoleRow {
  role: OrganizerRole;
  by: OrganizedBy;
  /** `organize_consented_at`, as the row holds it. NULL = nobody has asked this install to organize. */
  consentedAt: Date | null;
  status: string;
}

/**
 * Read one mailbox's role and holder, scoped by ACCOUNT.
 *
 * The account predicate is not decoration: without it a caller could learn the organizing state
 * of a mailbox id it guessed. Absent row ⇒ null, and the caller decides whether that is a 404 or
 * a no-op — {@link assertOrganizerRole} makes it a 404.
 */
export async function readOrganizerRole(
  tx: Tx, accountId: string, mailboxId: string,
): Promise<OrganizerRoleRow | null> {
  const [row] = await tx.select({
    role: mailboxes.organizerRole,
    kind: mailboxes.organizedByKind,
    name: mailboxes.organizedByName,
    since: mailboxes.organizedSince,
    consentedAt: mailboxes.organizeConsentedAt,
    status: mailboxes.status,
  })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)))
    .limit(1);
  if (!row) return null;
  return {
    // COERCED, never trusted: the column is NOT NULL with a CHECK behind it, so an unrecognised
    // value is unreachable from this tree — and the direction an unreachable state must fail in
    // is READER. Reading a value we do not understand as "organizer" would let a future
    // membership widening (or a hand-run UPDATE) silently hand a mailbox two organizers, which
    // is the one outcome this whole module exists to prevent.
    role: isOrganizerRole(row.role) ? row.role : "reader",
    by: {
      kind: isOrganizerKind(row.kind) ? row.kind : null,
      name: row.name ?? null,
      since: row.since ? row.since.toISOString() : null,
    },
    consentedAt: row.consentedAt ?? null,
    status: row.status,
  };
}

/**
 * THE ONE REFUSAL. Throws {@link OrganizedElsewhereError} when this install is a reader of this
 * mailbox, {@link MailboxNotFoundError} when the account does not hold it, and returns the row
 * otherwise.
 *
 * Called at the SERVICE write sites — the doors that move mail, change the organizer's store, or
 * mint an appointment — and NOT at the read sites, which is the whole point of the reader mode.
 * The exact set is pinned by `organizer-role-census.test.ts`.
 *
 * ── IT TAKES A `tx`, AND CALLERS PASS THE TRANSACTION THAT DOES THE WRITE ─────────────────
 *
 * A check on a separate connection is a check against a snapshot that may already be stale by the
 * time the write lands. Passing the writing transaction makes the refusal and the write see one
 * snapshot — and, where the caller also locks the mailbox row (`organizeHere` does), it makes the
 * pair atomic against a concurrent promotion. It deliberately does NOT take the row lock itself:
 * eleven read-mostly doors taking `FOR UPDATE` on a mailbox row would serialize every write on
 * the account behind each other for a check that almost always passes.
 *
 * The residual is one interleaving — a promotion committing between this read and the write —
 * and it converges in the safe direction: the write is one an organizer was entitled to make, by
 * an install that has just become the organizer.
 */
export async function assertOrganizerRole(
  tx: Tx, accountId: string, mailboxId: string,
): Promise<OrganizerRoleRow> {
  const row = await readOrganizerRole(tx, accountId, mailboxId);
  if (!row) throw new MailboxNotFoundError(mailboxId);
  if (row.role !== "organizer") throw new OrganizedElsewhereError(mailboxId, row.by);
  return row;
}

/**
 * THE ACCOUNT-SCOPED VARIANT — for the doors that are configuration rather than mail.
 *
 * Rules, tag definitions, notify rules, the away responder and the consent settings are not about
 * ONE mailbox: they are the account's standing instructions, and an account may hold several
 * mailboxes with different roles. So the question is not "is this mailbox mine to organize" but
 * "does this account organize anything at all", and the answer is permitted iff at least one
 * mailbox is an organizer.
 *
 * ── ON A ONE-MAILBOX STANDALONE THIS COLLAPSES TO "ALL REFUSED", AND THAT IS CORRECT ──────
 *
 * The standalone install with one reader mailbox can change no rules, no tags and no window,
 * which reads as harsh until you ask what a rule WOULD do: nothing, because rules are executed by
 * the organizer's own pipeline against the organizer's own store, and this install runs neither.
 * A settings screen that accepted the edit and then never applied it is the worse answer — it is
 * the switch that wires to nothing, which this repository already has a row open about.
 *
 * ── AND IT IS DELIBERATELY NOT "≥1 CONSENTED MAILBOX" ────────────────────────────────────
 *
 * `organizer_role = 'organizer'` is the state in which this install's pipeline actually runs.
 * A consented mailbox that has been demoted is one this install is not organizing right now, and
 * a rule written for it would sit unapplied until the mailbox came back — which may be never.
 *
 * `status <> 'disabled'` because a tombstone organizes nothing: the row keeps its role (a removal
 * demotes nothing, it retires the mailbox), so without this clause an account whose only mailbox
 * was deleted would still be told it organizes something.
 */
export async function assertAccountOrganizes(tx: Tx, accountId: string): Promise<void> {
  const [row] = await tx.select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      eq(mailboxes.organizerRole, "organizer"),
      ne(mailboxes.status, "disabled"),
    ))
    .limit(1);
  if (row) return;
  // The holder of the FIRST reader, so the refusal can name somebody. Best-effort and separate
  // from the decision above: an account with no mailbox at all refuses with no holder named, and
  // that is a different sentence the copy layer composes from `by.kind === null`.
  const [held] = await tx.select({
    kind: mailboxes.organizedByKind,
    name: mailboxes.organizedByName,
    since: mailboxes.organizedSince,
  })
    .from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      eq(mailboxes.organizerRole, "reader"),
      ne(mailboxes.status, "disabled"),
      isNotNull(mailboxes.organizedByKind),
    ))
    .limit(1);
  throw new OrganizedElsewhereError(accountId, {
    kind: isOrganizerKind(held?.kind) ? held!.kind as OrganizerKind : null,
    name: held?.name ?? null,
    since: held?.since ? held.since.toISOString() : null,
  });
}
