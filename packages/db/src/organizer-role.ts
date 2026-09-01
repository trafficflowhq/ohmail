import { and, eq, ne } from "drizzle-orm";
import { mailboxes } from "./schema-mail.js";
import { isMailboxDisabledReason, type MailboxDisabledReason } from "./mailbox-errors.js";
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
 * This module reaches `schema-mail.js`, `change-log.js` and `mailbox-errors.js` alone, which keeps
 * it inside the desktop engine's closure rule (`index.ts`'s barrel header).
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
 * WHAT A ROW REMEMBERS ABOUT HAVING STOOD DOWN — the memory the mailbox itself cannot hold.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A COLUMN READ ──────────────────────────────────────────
 *
 * Five call sites across two tiers ask one question — *"has this install been told to stop
 * organizing this mailbox, and by whom?"* — and until mail 0083 the answer was one column:
 * `status = 'disabled'` with an `organized_elsewhere:*` reason. 0083 moved the fact to
 * `organizer_role` and left `disabled_reason` with no writer at all, so every one of those reads
 * silently began answering NULL: the desktop's launch catch-up for orphaned appointments stopped
 * running, a relaunch's initial organizer state claimed to be organizing, and BOTH reclaim doors
 * — the desktop's and Cloud's — reported no previous holder to the person who pressed the button.
 * Nothing failed anywhere; a row that says "nothing happened" is a coherent row.
 *
 * So the derivation lives in ONE place, beside the column it now reads, rather than being
 * re-spelled at five call sites that can drift apart again — and a standalone install and the
 * hosted service cannot answer the same question differently about the same mailbox.
 *
 * ── THE ORDER OF THE TWO ARMS IS LOAD-BEARING ─────────────────────────────────────────────
 *
 * `status = 'disabled'` is asked FIRST, because a tombstone keeps whatever role it had — a
 * removal demotes nothing, it retires the row — so a removed mailbox that was a reader would
 * otherwise report a stand-down that nobody performed and no takeover can end. On a `disabled`
 * row the reason is therefore still the whole answer, and that is not legacy support: it is the
 * discriminator `closeRemovedMailboxAppointments` and `ensureLocalWorld` both turn on
 * (`disabled` + a reason is a PAUSE this install must not resume from; `disabled` + none is a
 * TOMBSTONE the user asked for).
 *
 * The second arm is the live one, and it asks TWO questions because `reader` carries two states:
 * a mailbox nobody has consented to organize is a reader too. See the guard in the body.
 *
 * A reader is `connected`, on its own roster, and its
 * `organized_by_kind` is the same closed three the reason's suffix carries — which is exactly
 * what migration 0083's backfill relied on when it split the one column into the other two, so
 * recomposing the string here is reading back what that migration wrote rather than inventing a
 * value. `'unknown'` for a reader whose first cycle has not looked yet: the row says somebody
 * else organizes this mailbox and does not yet say who, and the stand-down memory must survive
 * that gap or a relaunch inside it auto-resumes.
 */
export function standDownMemory(row: {
  status: string;
  organizerRole: string | null;
  organizedByKind: string | null;
  organizeConsentedAt: Date | null;
  disabledReason: string | null;
}): MailboxDisabledReason | null {
  if (row.status === "disabled") {
    return isMailboxDisabledReason(row.disabledReason) ? row.disabledReason : null;
  }
  if (row.organizerRole !== "reader") return null;
  /* -- A READER WITH NEITHER A HOLDER NOR A CONSENT NEVER STOOD DOWN --------------------------
   *
   * `reader` is the PRE-CONSENT state as well as the lost-the-lease one, and `schema-mail.ts`
   * says so in as many words: *"What separates the two is `organizeConsentedAt`, not this
   * column."* Reading the role alone conflated them, and the common Cloud path is the one that
   * suffered: `POST /mailboxes` creates a reader with no consent and no holder so a fresh connect
   * mirrors and moves nothing, and this reported `organized_elsewhere:unknown` for it — so the
   * FIRST press of "organize here" answered that the mailbox had been taken back from another
   * organizer, on a mailbox nobody had ever organized. That is the contract
   * `MailboxTakeoverResult.previousReason` states (a consent-less mailbox answers `null`), broken
   * by the function that was supposed to serve it.
   *
   * THE TEST IS `holder OR consent`, NOT CONSENT ALONE, and the second term is the one a reader
   * of `schema-mail.ts` would leave out. A stand-down writes `organized_by_kind` in the SAME
   * statement as the role (`markMailboxStoodDown`, and the sidecar's inline write) but writes no
   * consent — so on a desktop row whose consent predates the stamp `ensureLocalWorld` now sets, a
   * consent-only test would read a genuine stand-down as "never asked" and let the install
   * auto-resume. Either fact present means somebody has been organizing this mailbox; only a row
   * with neither is untouched.
   */
  if (row.organizedByKind === null && row.organizeConsentedAt === null) return null;
  const kind = isOrganizerKind(row.organizedByKind) ? row.organizedByKind : "unknown";
  const reason = `organized_elsewhere:${kind}`;
  /* Composed and then CHECKED rather than cast — and the check is UNREACHABLE from today's tree,
     which is stated rather than left to look load-bearing. `isOrganizerKind` above already
     narrowed the kind to the same closed three `disabled_reason`'s suffix carries, so the string
     is valid by construction and a mutation removing this line goes GREEN (run, not assumed).
     It stays for `markMailboxStoodDown`'s reason-coercion's reason: it is the guard for the day
     the two sets stop being equal. A fourth organizer kind would otherwise mint a reason no
     `STAND_DOWN_SEND_SENTENCES` entry exists for, and close an appointment with `undefined` in
     the sentence a person reads about their unsent message. */
  return isMailboxDisabledReason(reason) ? reason : "organized_elsewhere:unknown";
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
  /**
   * `lock: true` takes `FOR SHARE` on the mailbox row — see {@link assertOrganizerRole} for why a
   * share lock and not an exclusive one. Absent for the PLAIN READS (a DTO projection, a banner),
   * which want the row and not a promise about what happens next.
   */
  opts: { lock?: boolean } = {},
): Promise<OrganizerRoleRow | null> {
  const q = tx.select({
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
  const [row] = await (opts.lock === true ? q.for("share") : q);
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
 * ── IT TAKES THE ROW LOCK, AND THE VERSION THAT DID NOT WAS WRONG ─────────────────────────
 *
 * This function's first version took the caller's `tx` and did an UNLOCKED select, on the stated
 * ground that "passing the writing transaction makes the refusal and the write see one snapshot".
 * **That ground is false, and a max-effort review found it.** PostgreSQL's default isolation is
 * READ COMMITTED, where each STATEMENT takes a fresh snapshot — transaction membership is not a
 * snapshot and is not atomicity. So the interleaving was:
 *
 *   transaction A (a move) reads `organizer_role = 'organizer'` and passes
 *   transaction B (the worker's gate) commits the demotion to `'reader'`
 *   transaction A writes `folder_state.desired_folder` with `last_set_by: 'us'` and commits
 *
 * — a reader crossing a forbidden write door, and leaving an intent that fires on the next
 * promotion. The old note reasoned only about a concurrent PROMOTION (which does converge in the
 * safe direction) and missed the DEMOTION, which is the direction that matters.
 *
 * `FOR SHARE` and not `FOR UPDATE`: eleven doors taking an exclusive lock on one mailbox row
 * would serialize every write on the account behind each other for a check that almost always
 * passes. A share lock is exactly what is needed — it is compatible with other readers, so two
 * moves on one mailbox still run side by side, and it BLOCKS the demotion, whose `UPDATE` needs
 * an exclusive row lock. The gate therefore waits for the in-flight write instead of overtaking
 * it, and the write it waited for is one an organizer was entitled to make.
 *
 * ── AND IT IS ONLY A LOCK IF THE CALLER IS IN A TRANSACTION ───────────────────────────────
 *
 * A row lock lives until COMMIT. Called on an ambient handle the lock is taken and released with
 * the implicit single-statement transaction, which closes nothing — so a caller that means to be
 * protected must pass the transaction that performs the write. Nine of the eleven do. The two
 * that do not (`requestResync`, and the junk doors, which sit ahead of their own transactions)
 * are stated at their call sites as narrow rather than left to look atomic.
 */
export async function assertOrganizerRole(
  tx: Tx, accountId: string, mailboxId: string,
): Promise<OrganizerRoleRow> {
  const row = await readOrganizerRole(tx, accountId, mailboxId, { lock: true });
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
  // ONE PASS over the account's live mailboxes, projecting what both decisions below need. Two
  // queries were two round trips for a question one answer settles.
  const live = await tx.select({
    role: mailboxes.organizerRole,
    kind: mailboxes.organizedByKind,
    name: mailboxes.organizedByName,
    since: mailboxes.organizedSince,
  })
    .from(mailboxes)
    .where(and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled")));

  if (live.some((m) => m.role === "organizer")) return;

  /* -- AN ACCOUNT WITH NO LIVE MAILBOX IS PERMITTED, AND THE FIRST VERSION REFUSED IT --------
   *
   * "No organizer mailbox" has two causes and only one of them is this refusal's subject:
   *
   *   · every mailbox is a READER — somebody else organizes them. That is the case, and it is
   *     refused: the config would be an instruction this install never carries out, and rules
   *     TRAVEL, so writing one here reaches the install that does hold the mailbox.
   *   · there is NO live mailbox at all. Nothing is organized by anybody, there is no holder to
   *     name, and the sentence this would throw ("another install is organizing this mailbox")
   *     would be false. It is also the state every account is in before it connects one, so
   *     refusing it means a person cannot write a rule, name a tag or reset their screening until
   *     they have a mailbox — which broke three existing suites and would have broken the product
   *     in the same way.
   *
   * The permissive answer here is the same one `consent-seed.ts` gets and for the same reason:
   * account configuration is INERT until something organizes, and inert is not dangerous. What is
   * dangerous is configuration that reaches an organizer which is somebody else's.
   */
  if (live.length === 0) return;

  // The holder of the FIRST reader that names one, so the refusal can say who. Best-effort and
  // separate from the decision above: a reader whose holder columns are still NULL (its first
  // cycle has not looked yet) refuses with no holder named, which is a different sentence the
  // copy layer composes from `by.kind === null`.
  const held = live.find((m) => m.kind !== null) ?? null;
  throw new OrganizedElsewhereError(accountId, {
    kind: isOrganizerKind(held?.kind) ? held!.kind as OrganizerKind : null,
    name: held?.name ?? null,
    since: held?.since ? held.since.toISOString() : null,
  });
}
