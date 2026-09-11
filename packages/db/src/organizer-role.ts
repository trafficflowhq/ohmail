import { and, eq, ne } from "drizzle-orm";
import type { Dialect } from "./dialect/index.js";
import { mailboxes } from "./schema-mail.js";
import { isMailboxDisabledReason, type MailboxDisabledReason } from "./mailbox-errors.js";
import type { Tx } from "./change-log.js";

/**
 * What an organizer tells readers it can do — the whole vocabulary, defined HERE and nowhere else
 * (core depends on db, never the reverse); `organizer-lease.ts` re-exports these names. A
 * capability means "this build contains an applier for that kind of request". Advisory, never the
 * gate: a claim is a message anyone with APPEND rights can write — an attacker can make a reader
 * BELIEVE, and gains nothing, because the reader's record is signed. Absent must fail closed;
 * present must never be trusted as authority. Four members, one per family, NOT a version number:
 * the question a reader has is "will you take THIS", and a single flag would queue a move nobody
 * will ever take.
 */
export const CAPABILITY_REQUESTS = "requests";
/** Moving one message to one destination — `message.move`. Screener release and Quarantine rescue are moves. */
export const CAPABILITY_MOVES = "moves";
/** Creating, changing or deleting a rule — `rule.create`, `rule.update`, `rule.delete`. */
export const CAPABILITY_RULES = "rules";
/** Editing the per-mailbox configuration — `profile.update`. */
export const CAPABILITY_PROFILE = "profile";

/**
 * The organizing role, and the one refusal every write door shares. Exactly one active organizer
 * per mailbox; the loser is A READER — another mail client on the same mailbox. A reader MAY
 * read, search its mirror, mark read, send, draft with AI; since mail 0088/0089 also screener
 * SUGGEST, and DECIDE as a REQUEST the organizer applies on its own pass. MAY NOT: rules, move,
 * delete, triage, tags, schedule, unsubscribe, junk sweep/rescue, resync, profile publish — each
 * moves mail, changes the organizer's store, or mints an appointment a demotion would cancel.
 * Here, not in services: the worker may not import services at runtime. The write-door set is
 * pinned by census, in both directions.
 */

/** The two roles. Closed by `mailboxes_organizer_role_closed`; the column is NOT NULL. */
export const ORGANIZER_ROLES = ["organizer", "reader"] as const;
export type OrganizerRole = (typeof ORGANIZER_ROLES)[number];

export function isOrganizerRole(v: unknown): v is OrganizerRole {
  return typeof v === "string" && (ORGANIZER_ROLES as readonly string[]).includes(v);
}

/**
 * The organizer kinds — the same closed set `disabled_reason`'s suffix carries, and `'unknown'`
 * is what makes it closed rather than merely small (a peer this build cannot rank).
 * Closed by `mailboxes_organized_by_kind_closed`.
 *
 * `'mobile'` is a standalone phone, which organizes only while the app is open. It arrived a
 * release after the phone started WRITING it: a reader that could not rank the value read it as
 * `unknown`, and the phone read its own renew residue that way and stood down from its own
 * mailbox. The engine's own set (`packages/core`, `OrganizerKind`) carries the same members.
 */
export const ORGANIZER_KINDS = ["cloud", "local", "mobile", "unknown"] as const;
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
 * The cap on a customer's machine name, applied at the single write site. `organized_by_name` is
 * `X-Ohmail-Display-Name` off another install's claim — a string that install chose. No CHECK:
 * free text closes no set, and a byte bound in the database answers 23514 to a person who named
 * their laptop; the bound lives HERE. 120 is generous for a hostname and short enough that the
 * value cannot become a payload. Paired with {@link organizerDisplayName}, which also strips
 * CR/LF: the value arrives out of an RFC822 header and goes back into one on the next claim, so a
 * newline could inject a header field — `headerSafe`'s strip, applied on the way IN.
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
 * What a row remembers about having stood down — the memory the mailbox itself cannot hold. Five
 * call sites ask one question — told to stop organizing, and by whom? — and when the answer moved
 * off `disabled_reason`, every one silently began answering NULL: the launch catch-up stopped and
 * both reclaim doors reported no previous holder. So the derivation lives in ONE place. `status =
 * 'disabled'` is asked FIRST — a removal retires the row without demoting, so a tombstone keeps
 * its role, and there the reason is the whole answer (reason = PAUSE; none = TOMBSTONE). The live
 * arm asks three questions: `reader` carries no-consent-yet, stood-down, and (0.14.1)
 * deliberately released — a release is not distinguishable by absence, so it is a MARKER.
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
  /**
   * A reader with neither a holder nor a consent never stood down. `reader` is the PRE-CONSENT
   * state as well as the lost-the-lease one (`organizeConsentedAt` separates them, not this
   * column). Reading the role alone conflated them: `POST /mailboxes` creates a reader with no
   * consent and no holder, and the FIRST press of "organize here" claimed a takeover from an
   * organizer that never existed. The test is `holder OR consent`, NOT consent alone: a
   * stand-down writes `organized_by_kind` in the same statement as the role but writes no
   * consent, so a consent-only test would read a genuine stand-down as "never asked" and
   * auto-resume. Only a row with neither fact is untouched.
   */
  if (row.organizedByKind === null && row.organizeConsentedAt === null) return null;
  /**
   * The THIRD `reader` state (0.14.1): the person pressed "stop organizing here" and NOBODY took
   * the mailbox. Without this arm a release reads as `organized_elsewhere:unknown`, and the
   * claim-back would report a takeover from an organizer that never existed. A MARKER, not an
   * absence: the holder-refresh writers set all four holder columns NULL when the peek finds an
   * EMPTY folder — what a stood-down reader sees when its winner goes away — so a genuine
   * stand-down decays into the "released" shape one poll later. Hence `organizer_released_at`,
   * written only by the release, cleared by every promotion. Safe only because a reader with no
   * takeover stamp never enters `runLeaseGate`.
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
 * composes ONE sentence rather than eleven. Not a `ServiceError`: it is thrown from
 * `@trafficflow/db`, which cannot import `@trafficflow/services` (the dependency runs the other
 * way) — and it must be thrown from here for the module header's reason. It carries the SAME four
 * fields, and `withErrorEnvelope` in `packages/api` maps it in its own arm beside that class, so
 * every route answers the envelope contract without a per-route catch. `retryable` is
 * deliberately absent, i.e. `undefined`: retrying changes nothing until a human takes the mailbox
 * back, and `retryable: false` would claim a permanence that a claim-back falsifies in one cycle.
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
  tx: Tx, d: Dialect, accountId: string, mailboxId: string,
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
  const [row] = await (opts.lock === true
    ? d.forUpdate(q, { mode: "share" })
    : q);
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
 * THE ONE REFUSAL. Throws {@link OrganizedElsewhereError} for a reader, {@link
 * MailboxNotFoundError} for a mailbox the account does not hold. Called at the SERVICE write
 * sites, never the read sites; the set is pinned by `organizer-role-census.test.ts`. It takes the
 * ROW LOCK, and the version that did not was wrong: under READ COMMITTED each statement takes a
 * fresh snapshot, so a move could read `organizer` while the gate committed the demotion — a
 * reader crossing a forbidden write door. `FOR SHARE`, not `FOR UPDATE`: compatible with other
 * readers, and it BLOCKS the demotion's exclusive lock. A row lock lives until COMMIT: nine of
 * eleven doors pass a transaction; the two that do not are stated narrow.
 */
export async function assertOrganizerRole(
  tx: Tx, d: Dialect, accountId: string, mailboxId: string,
): Promise<OrganizerRoleRow> {
  const row = await readOrganizerRole(tx, d, accountId, mailboxId, { lock: true });
  if (!row) throw new MailboxNotFoundError(mailboxId);
  if (row.role !== "organizer") throw new OrganizedElsewhereError(mailboxId, row.by);
  return row;
}

/**
 * The account-scoped variant — for the doors that are configuration rather than mail. Rules,
 * tags, the away responder and consent settings are the account's standing instructions, so the
 * question is "does this account organize anything at all" — permitted iff at least one mailbox
 * is an organizer. On a one-mailbox standalone this collapses to "all refused", correctly: rules
 * are executed by the organizer's own pipeline, which this install does not run — a settings
 * screen that accepted the edit and never applied it is worse. NOT "≥1 consented mailbox": a
 * consented-but-demoted mailbox is not being organized, and its rule would sit unapplied. `status
 * <> 'disabled'`: a tombstone keeps its role and organizes nothing.
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

  /**
   * An account with NO live mailbox is permitted, and the first version refused it. Two causes,
   * one subject: every mailbox a READER — refused, because the config would be an instruction
   * this install never carries out, and rules TRAVEL; and NO live mailbox at all — no holder to
   * name, and the refusal's sentence would be false. The second is every account's state before
   * it connects a mailbox, so refusing it means nobody can write a rule or reset screening until
   * they have one. As in `consent-seed.ts`: account configuration is INERT until something
   * organizes — what is dangerous is configuration that reaches an organizer which is somebody
   * else's.
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
 * Whether a reader's decision may become a request (0.14.1). A PLAIN read, never `FOR SHARE`: it
 * answers a question about the mailbox's HOLDER, not about a write this transaction makes.
 * `capable` is TRUE only when the role is `organizer` for THIS install (a direct write needs no
 * request) OR the holder's claim advertises THE CAPABILITY THE CALLER NAMED and `organizer_state
 * = 'held'` — a `stopped` holder is not coming back; do not queue a decision nobody will take.
 * The capability is REQUIRED (mail 0094): a default would let a caller ask about Screener
 * decisions while queueing a move and get `capable: true` off an older organizer. `status <>
 * 'disabled'`: a tombstone keeps its stale role column.
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
