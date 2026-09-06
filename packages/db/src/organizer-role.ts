import { and, eq, ne } from "drizzle-orm";
import { mailboxes } from "./schema-mail.js";
import { isMailboxDisabledReason, type MailboxDisabledReason } from "./mailbox-errors.js";
import type { Tx } from "./change-log.js";

/**
 * WHAT AN ORGANIZER TELLS READERS IT CAN DO — the whole vocabulary, defined HERE and nowhere else.
 *
 * `@trafficflow/core` DEPENDS ON `@trafficflow/db` (`packages/core/package.json`), never the
 * reverse — `packages/db/package.json` names no `@trafficflow/core` dependency. So this package
 * is the one that cannot reach the other, which makes it the only place a single definition can
 * live: `organizer-lease.ts` RE-EXPORTS these names rather than spelling them again.
 *
 * That last paragraph used to say the opposite — "two literals, one spelling, held equal by
 * `organizer-role-capability.test.ts`" — and it outlived the arrangement it described by a whole
 * migration. Mail 0090 deleted the second literal and the equality test with it (a test that
 * compares a constant to itself is not a guard); the comment stayed, so a reader arriving here
 * was told to go maintain a duplicate that does not exist. Corrected in the slice that extends
 * the set, because a comment documenting an invariant is the claim under test rather than
 * evidence for it.
 *
 * ── WHAT A CAPABILITY MEANS, AND WHAT IT DOES NOT ─────────────────────────────────────────
 *
 * "This organizer's build contains an applier for that kind of request." It is advisory, and it
 * is never the gate: a claim is a message anyone with APPEND rights on the mailbox can write, so
 * an attacker can make a reader BELIEVE an organizer is capable. What that buys them is nothing —
 * the reader appends a record signed with a key it holds, and the organizer either holds the same
 * key or refuses it. The header speeds up the honest case; the SIGNATURE makes the dishonest one
 * harmless.
 *
 * So a capability that is ABSENT must fail closed and a capability that is PRESENT must never be
 * trusted as authority. Both halves matter and they pull in opposite directions.
 *
 * ── FOUR MEMBERS, ONE PER FAMILY OF THING A READER CAN ASK FOR ────────────────────────────
 *
 * Separate members rather than one "modern build" flag, because they arrive in different releases
 * and a reader has to be able to ask about the one it needs. An organizer shipped before mail 0093
 * advertises `requests` alone: it drains Screener decisions and has no applier for a move, a rule
 * or a profile edit. A reader that read a single flag off such a claim would queue a move nobody
 * is ever going to take, and the person would watch a message sit in a pending state for ever.
 * With a member per family the same reader is refused at its own door, immediately, with a
 * sentence naming what is out of date.
 *
 * They are deliberately NOT a version number. A version says "how new is this build" and the
 * question every reader actually has is "will you take THIS", which stays answerable when builds
 * gain abilities in an order nobody planned.
 */
export const CAPABILITY_REQUESTS = "requests";
/** Moving one message to one destination — `message.move`. Screener release and Quarantine rescue are moves. */
export const CAPABILITY_MOVES = "moves";
/** Creating, changing or deleting a rule — `rule.create`, `rule.update`, `rule.delete`. */
export const CAPABILITY_RULES = "rules";
/** Editing the per-mailbox configuration — `profile.update`. */
export const CAPABILITY_PROFILE = "profile";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ORGANIZING ROLE, AND THE ONE REFUSAL EVERY WRITE DOOR SHARES 
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Exactly one active organizer per mailbox is the invariant the product rests on. What changed
 * with the mailbox-removal design is what the LOSER does: it used to stop entirely (`status='disabled'` plus an
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
 * **AS OF MAIL 0088/0089 (0.14.1): screener SUGGEST too — local compute against this
 * door's own provider or this account's own credits, writing nothing an organizer would contend
 * with — and screener DECIDE, not as a direct write but as a REQUEST**: the reader's decision is
 * appended to `ohmail/_meta` and applied by the organizer on its own next pass
 * (`readRequestEligibility`, `apps/worker/src/request-drain.ts`). Superseded here rather than
 * silently: `organizer-role-census.test.ts` no longer lists `screener-service.ts` among the
 * refusal sites, and this refusal ({@link assertOrganizerRole} / {@link assertAccountOrganizes})
 * stays the one a DIRECT write goes through — `ScreenerService.decide`'s organizer branch calls
 * `readRequestEligibility` instead, the per-mailbox read the request path also needs.
 *
 * MAY NOT: rules, move, delete (v1), triage, tags-assign, schedule, unsubscribe, junk
 * sweep/rescue, resync, profile publish. Every one of those either MOVES mail, changes the
 * organizer's own store in a way the organizer would then fight, or mints an appointment a
 * demotion would have to cancel.
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
 * `mailboxes.organized_by_capabilities` (0.14.1), THE SINGLE WRITE SITE.
 *
 * Mirrors `X-Ohmail-Capabilities`'s own wire shape (`organizer-lease.ts#formatClaim`): trimmed,
 * lowercased, empty members dropped, comma-joined — and an EMPTY result is NULL, never the empty
 * string, on {@link ClaimInput.capabilities}'s own reasoning one field over: a value that means
 * "nothing" has to be absent, because a reader one release older cannot tell an empty value from
 * one it does not understand.
 */
export function capabilitiesColumn(caps: readonly string[] | null | undefined): string | null {
  if (!caps || caps.length === 0) return null;
  const joined = caps.map((c) => c.trim().toLowerCase()).filter((c) => c !== "").join(",");
  return joined === "" ? null : joined;
}

/**
 * Does the holder's stored capability set include `capability`? Reads the column
 * {@link capabilitiesColumn} writes — a comma-joined, lowercased set, or NULL for "we have not
 * looked" / "the holder advertises nothing", which both answer `false` here, on purpose: absence
 * is the fail-safe reading everywhere this column is consulted (see its own schema comment).
 */
export function hasCapability(column: string | null | undefined, capability: string): boolean {
  if (!column) return false;
  const want = capability.trim().toLowerCase();
  return column.split(",").map((c) => c.trim().toLowerCase()).includes(want);
}

/**
 * WHAT A ROW REMEMBERS ABOUT HAVING STOOD DOWN — the memory the mailbox itself cannot hold.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A COLUMN READ ──────────────────────────────────────────
 *
 * Five call sites across two tiers ask one question — *"has this install been told to stop
 * organizing this mailbox, and by whom?"* — and until the mailbox-removal design the answer was one column:
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
 * The second arm is the live one, and it asks THREE questions because `reader` carries THREE
 * states — a mailbox nobody has consented to organize is a reader, and since 0.14.1 so is one
 * whose owner deliberately released it. See the two guards in the body: the first is an absence
 * (no holder, no consent) and the second is a MARKER, because the release's own shape turned out
 * not to be distinguishable by absence at all.
 *
 * A reader is `connected`, on its own roster, and its
 * `organized_by_kind` is the same closed three the reason's suffix carries — which is exactly
 * what migration 0083's backfill relied on when it split the one column into the other two, so
 * recomposing the string here is reading back what that migration wrote rather than inventing a
 * value.
 *
 * **The line that used to end this paragraph was retired by 0.14.1.** It read: *"`'unknown'`
 * for a reader whose first cycle has not looked yet: the row says somebody else organizes this
 * mailbox and does not yet say who, and the stand-down memory must survive that gap or a relaunch
 * inside it auto-resumes."* It is kept here rather than deleted because the hazard it names was
 * real and is now closed somewhere else: a reader with no takeover stamp never enters
 * `runLeaseGate` on either door, so a relaunch inside that gap cannot auto-resume whatever this
 * function answers. What the sentence cost, once the release existed, was the ability to tell a
 * released mailbox from a stood-down one at all — they are the same row shape — and the release is
 * a real state a person creates on purpose while the gap was a moment nothing observes. The gap
 * still resolves on the next peek, which writes a kind and a state.
 */
export function standDownMemory(row: {
  status: string;
  organizerRole: string | null;
  organizedByKind: string | null;
  organizeConsentedAt: Date | null;
  disabledReason: string | null;
  /**
   * Mail 0088 — the lease's occupancy as this row last recorded it, and the RELEASE MARKER.
   *
   * Both REQUIRED, not optional, for the reason every required field in this area is: an optional
   * field defaulted to `undefined` would make the released arm below unreachable at whichever call
   * site forgot it, and the symptom would be a released mailbox reported as a stand-down — an
   * offer to reverse a handover that never happened.
   */
  organizerState: string | null;
  organizerReleasedAt: Date | null;
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
  /* -- AND A RELEASED MAILBOX NEVER STOOD DOWN EITHER (0.14.1) -----------------------------
   *
   * The THIRD state a `reader` row can be in, and it did not exist when the two arms above were
   * written: the person pressed "stop organizing here", this install expunged its own claim, and
   * NOBODY took the mailbox. `markMailboxReleased` is what leaves it, and the sidecar's inline
   * twin.
   *
   * Without this arm a release reads as `organized_elsewhere:unknown` (the consent term of the
   * test above is satisfied), which is false in the way that matters most at the one door that
   * asks: the claim-back reports `previousReason`, so a person who had released their own mailbox
   * and then pressed "Organize here" would be told they had just taken it back from another
   * organizer that never existed.
   *
   * ── THE DISCRIMINATOR IS A MARKER, AND THE ABSENCE THAT LOOKED LIKE ONE IS NOT EXACT ───────
   *
   * This arm read `organized_by_kind IS NULL AND organizer_state IS NULL AND consented`, on the
   * argument that a genuine stand-down writes both holder columns in the SAME statement as the
   * role, so the shape is unreachable from one. **That argument is wrong, and a review round found
   * it.** `markMailboxStoodDown` is not the last writer of those columns: `refreshOrganizerHolder`
   * and the sidecar's `notePeekedHolder` are enumerated writers of the same triple, and both write
   * all four holder columns NULL whenever the per-cycle peek finds an EMPTY folder — which is
   * exactly what a stood-down reader sees the moment the install that beat it releases or is
   * removed. A genuine stand-down therefore decays into the "released" shape on its own, one poll
   * later, with nothing having released anything.
   *
   * The cost of that was not the sentence alone. `world.standDownReason` feeds the desktop's
   * LAUNCH CATCH-UP for orphaned scheduled sends, so a stood-down install whose winner had gone
   * away would stop closing them — the appointment goes on saying "Sends Tue 14:50" for a time
   * that has passed, for ever, which is the orphan `closeStoodDownAppointments` exists for.
   *
   * So the release writes a MARKER only the release writes (`organizer_released_at`, 0.14.1)
   * and this arm keys on it. Every promotion clears it, so it describes the current state.
   *
   * ── AND WHAT MAKES IT SAFE, WHICH IS NOT THIS FUNCTION ─────────────────────────────────────
   *
   * The auto-resume this memory exists to prevent is closed STRUCTURALLY as of 0.14.1: a reader
   * with no takeover stamp never enters `runLeaseGate` on EITHER door, so an empty folder can no
   * longer be read as permission whatever this function answers. That is why the arm can be added
   * at all — before the gate fix, returning `null` here would have let the very next cycle
   * re-promote the install that had just been asked to stop, which is this feature's own named
   * risk. The two changes are one change and neither is correct alone.
   */
  /* LOOSE EQUALITY, DELIBERATELY. The field is required by the type, so typed code cannot omit it —
     but this function is reachable from code that is not typechecked, and a caller that selected
     the row without this column would hand it `undefined`. `!== null` reads `undefined` as A
     RELEASE and erases the memory for every row it is asked about, which is the failure this arm
     exists to prevent, inverted. `!= null` reads an absent value as NOT RELEASED, which keeps the
     memory — the direction that costs a wrong sentence rather than a lost one. */
  if (row.organizerReleasedAt != null) return null;
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
/**
 * WHY A REQUEST WAS NOT OFFERED (0.14.1) — the finer-grained reason
 * `readRequestEligibility` names beside `OrganizedElsewhereError`'s ordinary `by`.
 *
 *  · `organizer_outdated` — a holder EXISTS and is `held`, but its claim does not advertise
 *    {@link CAPABILITY_REQUESTS}: a build that will never call `applyMetaRequests`. Offering a
 *    request to it would queue a decision nobody is ever going to take.
 *  · `no_organizer` — there is no live holder to offer one to at all: nobody has ever organized
 *    this mailbox, or the last one stopped and nothing has claimed it since.
 */
export type RequestRefusalReason = "organizer_outdated" | "no_organizer";

export class OrganizedElsewhereError extends Error {
  readonly code = "organized_elsewhere";
  readonly httpStatus = 409;
  readonly details: { by: OrganizedBy; reason?: RequestRefusalReason };
  /**
   * `reason` is OPTIONAL and additive: every existing call site (the per-mailbox write refusal,
   * the account-scoped configuration refusal) passes none, and the client's existing copy for
   * "another install organizes this mailbox" is unchanged by its absence. It exists for the ONE
   * new caller that needs a finer answer than "somebody else organizes this" — a reader asking
   * whether its decision may become a request at all.
   */
  constructor(readonly mailboxId: string, by: OrganizedBy, reason?: RequestRefusalReason) {
    super(
      "another install is organizing this mailbox, so this one is a reader: it mirrors the "
      + "mailbox and can mark mail read and send, but it does not move, file or delete mail. "
      + "Choose to organize here instead if you want this install to take it over.",
    );
    this.name = "OrganizedElsewhereError";
    this.details = reason === undefined ? { by } : { by, reason };
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

/**
 * WHETHER A READER'S DECISION MAY BECOME A REQUEST, FOR ONE MAILBOX (0.14.1).
 *
 * A PLAIN read, deliberately — never `FOR SHARE` — because this answers a question about the
 * MAILBOX's holder, not about a write this transaction is about to make; the write door's own
 * `assertOrganizerRole` still takes its lock where a write follows. This is consulted by
 * `ScreenerService.decide`'s reader branch, at the API tier, which has no live IMAP connection —
 * the row is the only place it can ask "will the holder ever take this decision".
 *
 * `capable` is TRUE only when the row's role is `organizer` for THIS install (the direct-write
 * case needs no request at all) OR the holder's own claim advertises THE CAPABILITY THE CALLER
 * NAMED AND `organizer_state = 'held'` — a `stopped` holder is not coming back to drain anything,
 * and an absent capability means either "we have not looked" or "that build has no applier for
 * this kind" (the rule that only the organizer moves mail), and both read the same to a person:
 * do not queue a decision nobody will ever take.
 *
 * ── THE CAPABILITY IS A REQUIRED ARGUMENT, AND THAT IS THE POINT (mail 0093) ───────────────
 *
 * It used to be the constant {@link CAPABILITY_REQUESTS}, hard-coded here, because there was one
 * kind of request. There are now three families — moves, rules and profile edits — and they are
 * NOT interchangeable: an organizer shipped before mail 0093 advertises `requests` and has no
 * applier for any of them.
 *
 * A DEFAULT would have been the quiet failure. A new caller that forgot the argument would ask
 * "will you take a Screener decision?" while queueing a move, get `capable: true` off a
 * 0.14.1 organizer, write the record, and the person would watch a message sit pending until it
 * expired — every guard green, because the read did answer the question it was asked. Required,
 * so forgetting is a compile error, on the same argument `RequestInput.key` is required rather
 * than optional: the failure mode of the lax version is a silent downgrade to the old behaviour.
 *
 * ── AND IT IS NOT CONSULTED FOR THIS INSTALL'S OWN ORGANIZER ROW ──────────────────────────
 *
 * `role === "organizer"` short-circuits before the capability is read, for every kind. That is
 * correct and not an oversight: the capability column describes a PEER, and an install writing to
 * a mailbox it organizes itself makes no request and needs no applier on anybody else's side. The
 * question "can I do this here" is answered by this build's own code, which is present by
 * construction. `status <> 'disabled'` for the SAME reason `assertAccountOrganizes` checks it above: a
 * tombstoned mailbox keeps whatever `organizer_role` it had at removal (the mailbox-removal design — a removal
 * retires the mailbox, it does not demote it), so without this a decision against a mailbox that
 * no longer exists in any live sense would still read `capable: true` off the stale role column.
 */
export interface RequestEligibility {
  role: OrganizerRole;
  state: OrganizerState | null;
  /**
   * `organizer_role = 'organizer'`, OR (the holder advertises THE CAPABILITY THE CALLER ASKED
   * ABOUT and `organizer_state = 'held'`). It is an answer to one question about one kind of
   * request, never a general "this holder is modern" — see the function's header.
   */
  capable: boolean;
  by: OrganizedBy;
  /**
   * The mailbox's own `status`, so a caller can tell a TOMBSTONE from a reader. Both answer
   * `capable: false`, and they are not the same thing: a removed mailbox is organized by nobody,
   * so refusing it with "another install is organizing this" names a holder that no longer holds
   * anything and offers a takeover of a mailbox that is gone. `ScreenerService.decide` reads this
   * and answers not-found instead.
   */
  status: string;
}

export async function readRequestEligibility(
  tx: Tx, accountId: string, mailboxId: string,
  /**
   * WHICH CAPABILITY THIS DECISION NEEDS FROM THE HOLDER — one of the four exported at the top of
   * this file. Required; see the header for why a default would fail open.
   */
  capability: string,
): Promise<RequestEligibility | null> {
  const [row] = await tx.select({
    role: mailboxes.organizerRole,
    state: mailboxes.organizerState,
    capabilities: mailboxes.organizedByCapabilities,
    kind: mailboxes.organizedByKind,
    name: mailboxes.organizedByName,
    since: mailboxes.organizedSince,
    status: mailboxes.status,
  })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)))
    .limit(1);
  if (!row) return null;

  const role: OrganizerRole = isOrganizerRole(row.role) ? row.role : "reader";
  const state: OrganizerState | null = isOrganizerState(row.state) ? row.state : null;
  const capable = row.status !== "disabled"
    && (role === "organizer" || (state === "held" && hasCapability(row.capabilities, capability)));

  return {
    role,
    state,
    capable,
    status: row.status,
    by: {
      kind: isOrganizerKind(row.kind) ? row.kind : null,
      name: row.name ?? null,
      since: row.since ? row.since.toISOString() : null,
    },
  };
}
