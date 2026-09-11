/**
 * What is happening to my mail — one derivation for every surface (the old
 * "Waiting for first sync" stayed up half an hour while mail arrived).
 * `lastSyncAt` cannot be a progress signal: SHARED (one UPDATE stamps every
 * mailbox a cycle served) and EARLY (stamped per cycle whatever the
 * backlog) — read exactly once, as `=== null`. The growing state keys on
 * the MIRROR GROWING; the one sound server stamp, `initial_import_completed_at`, is read as a bounded floor
 * ({@link importFloorSpeaks}). Pure, run once per shell: three surfaces
 * render its answer, none decides; the growth sampler is stateful.
 */

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHAT THE CLIENT CAN ACTUALLY OBSERVE
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The ways our own infrastructure declines to serve a mailbox (mail 0029).
 * A closed set with a CHECK behind it, owned server-side as
 * `MAILBOX_SYNC_BLOCK_REASONS`; re-declared here because this module ships
 * in the Desktop app, which is built without the server packages.
 * `test/mail-state.test.ts` asserts, from `@trafficflow/db`, that the two
 * arrays are the same and that `en.json` carries a sentence for every
 * member — drift is a red test. At runtime an unrecognised reason still
 * produces `blocked` with generic copy: a server that grows a fourth reason must not be answered with silence.
 */
/* The ONE mailbox-address grouping rule, shared with the Mailboxes pane. This module had no
   imports at all before it; it has this one because the alternative is a second copy of a rule
   that must never diverge from the pane's — see `address-key.ts`. */
import { addressKey } from "./address-key";

export const SYNC_BLOCK_REASONS = [
  "lease_unreadable",
  "awaiting_credentials",
  "at_capacity",
  "read_limited",
] as const;
export type SyncBlockReason = (typeof SYNC_BLOCK_REASONS)[number];

export function isSyncBlockReason(v: unknown): v is SyncBlockReason {
  return typeof v === "string" && (SYNC_BLOCK_REASONS as readonly string[]).includes(v);
}

/**
 * The organizer lease's verdict, as copy tokens. `mailboxes.disabled_reason`
 * (`MAILBOX_DISABLED_REASONS`, its own CHECK, server-owned) says why a mailbox is `disabled`
 * when the LEASE decided it. These values are NOT the wire's values, deliberately: the wire
 * tokens carry a colon (`organized_elsewhere:local`) and {@link MailState.reason} is copy —
 * `SyncBar` interpolates it into an i18n key — so mapping here keeps a server-owned string out
 * of the message namespace. {@link standDownToken} is the only place the vocabularies meet;
 * `test/mailbox-stand-down.test.tsx` reconciles the table with the source.
 */
export const STAND_DOWN_REASONS = [
  "organized_elsewhere_cloud",
  "organized_elsewhere_local",
  "organized_elsewhere_mobile",
  "organized_elsewhere_unknown",
] as const;
export type StandDownReason = (typeof STAND_DOWN_REASONS)[number];

/**
 * A `disabled_reason` off the wire, as the copy token for it. `null` in,
 * `null` out — the ordinary disconnect, which must stay distinguishable or
 * a mailbox the user removed on purpose is told another install claimed
 * it. Anything else in, `organized_elsewhere_unknown` out: the server
 * narrows unrecognised members to `:unknown` already, but during a deploy
 * this is the line that matters — answering an unknown member with `null`
 * would file a newer worker's stand-down as "the user disconnected this".
 * This function never returns `null` for a non-null input.
 */
export function standDownToken(wire: string | null): StandDownReason | null {
  if (wire === null) return null;
  if (wire === "organized_elsewhere:cloud") return "organized_elsewhere_cloud";
  if (wire === "organized_elsewhere:local") return "organized_elsewhere_local";
  if (wire === "organized_elsewhere:mobile") return "organized_elsewhere_mobile";
  return "organized_elsewhere_unknown";
}

/**
 * Is this install stood down from organizing this mailbox — and in whose favour? Not `status === 'disabled'`: since mail
 * 0083 a demoted install is `connected` with `organizer_role = 'reader'` and no reason, so that predicate matched
 * nothing this build writes. The rule mirrors the server's `standDownMemory`: a reader is also the pre-consent state, so
 * the test is a named holder OR a consent stamp — a reader with neither is a mailbox nobody has agreed to organize yet.
 * `status === 'disabled'` is asked first (a tombstone keeps its role). The sync rail must NOT call this (ruled
 * 2026-09-02): a reader's mirror is working, and `blocked` there would be false — the fact belongs to the mailbox pane's
 * row. `released` is a derived fourth answer, not a wire member: adding it to {@link STAND_DOWN_REASONS} would break the
 * reconciliation for a token the server cannot send.
 */
export type ReaderStandDown = StandDownReason | "released";

export function readerStandDown(m: {
  status?: string;
  disabledReason?: string | null;
  organizerRole?: "organizer" | "reader";
  organizedBy?: { kind: string | null; name: string | null; since: string | null } | null;
  organizeConsentedAt?: string | null;
  /**
   * THE RELEASE MARKER — the only column that separates "this account let the mailbox go" from
   * "the install that held it vanished". See the `released` arm below for why nothing else can.
   *
   * Optional like every other member: a host that predates it sends no marker, and absent reads
   * as NOT RELEASED, which keeps the stand-down sentence rather than inventing a release.
   */
  organizerReleasedAt?: string | null;
}): ReaderStandDown | null {
  // THE LEGACY WIRE FIRST, unchanged: `disabled` with a reason is what an engine older than the
  // role column reports, and it is still the only thing those rows can say.
  if (m.status === "disabled") return standDownToken(m.disabledReason ?? null);
  if (m.organizerRole !== "reader") return null;
  // A HOLDER IS NAMED — not merely "the object exists". The DTO guarantees `organizedBy` is null
  // as a whole when nobody is named, and testing `kind || name` rather than the object is what
  // keeps a host that starts sending `{null,null,null}` from putting a stand-down on every row.
  const holder = Boolean(m.organizedBy && (m.organizedBy.kind || m.organizedBy.name));
  /* ABSENT COUNTS AS "NOT CONSENTED" HERE, and that is the SAFE direction rather than the
     literal one. `MailboxFacts.organizeConsentedAt` has three states and absent means "this
     build cannot tell" — but the only host that can reach this line is one sending
     `organizerRole` and not the consent stamp, and on such a host a holder-less reader is
     equally likely to be a mailbox nobody has agreed to organize yet. Claiming a stand-down
     there would put "somebody else organizes this" over a fresh connect AND hang a claim button
     on a row whose next screen is the consent statement, which is the defect the holder-or-consent
     test above exists to prevent.
     Losing an explanation costs a sentence; inventing one costs a false claim. */
  const consented = m.organizeConsentedAt !== null && m.organizeConsentedAt !== undefined;
  if (!holder && !consented) return null;
  /* The release is its own answer, and the MARKER names it. A consented
   * reader with nobody holding it used to report
   * `organized_elsewhere_unknown` — a row arguing with its own claim
   * button. The discriminator is the marker, not the absent holder: the
   * per-cycle peek rewrites the holder columns all-null on an empty claim
   * folder, so a genuine stand-down decays into the holder-less shape;
   * `organizer_released_at` is written by the release alone and every
   * promotion clears it (`standDownMemory`, server-side). A host too old to
   * send the marker keeps the stand-down sentence — the cheaper error: a
   * stale explanation costs a sentence, a false release costs a claim. */
  if (!holder && m.organizerReleasedAt !== null && m.organizerReleasedAt !== undefined) {
    return "released";
  }
  return standDownToken(
    m.organizedBy?.kind ? `organized_elsewhere:${m.organizedBy.kind}` : "organized_elsewhere:unknown",
  );
}

/**
 * THIS INSTALL'S OWN CLAIM IS STILL ON THE MAILBOX WHILE THIS INSTALL IS NOT ORGANIZING IT.
 *
 * The two-sided belief, and a real state rather than a theoretical one: an install that stood down
 * without its claim being taken out of the mailbox leaves a record every OTHER install reads as
 * "somebody holds this", so they stand down too — and this one reads their absence the same way.
 * Nothing organizes the mailbox, and each side's row says the other one does. A claim seen this way
 * had been sitting for three days.
 *
 * ── "OURS" IS AN IDENTITY, AND `kind` CANNOT ANSWER IT ──────────────────────────────────────
 *
 * This asked `organizedBy.kind === "cloud"`, on the premise that a mailbox has one hosted
 * organizer. It does not: the hosted organizer's id is SCOPED BY ENVIRONMENT precisely so that a
 * staging deployment pointed at a production mailbox is a different organizer, and the claim
 * removal matches on that id. So `cloud` is what a SECOND Cloud deployment is too, and the
 * predicate answered "ours" over a claim this install could not remove — the hand-back was offered,
 * the row was cleared, and the claim stayed in the folder.
 *
 * A mailbox has one organizer AT A TIME; another Cloud install is a foreign one, exactly like a
 * foreign desktop. So the server compares the ids and sends the answer, and this reads it. The id
 * itself is not on the wire — it is an internal deployment name with no use on a screen — and
 * re-deriving the comparison here would be the same rule in two vocabularies, which is what went
 * wrong the first time.
 *
 * The verb this unlocks is the ordinary release — the only thing that takes a claim off a mailbox is
 * the process holding it — so the mechanism is unchanged and only its REACHABILITY moves. The rule
 * is that the release is reachable whenever this install's claim is on the mailbox, whatever the
 * local stand-down state says, because the stand-down state is exactly what is wrong here.
 *
 * Consent is asked for the reason {@link readerStandDown} asks it: a reader that never agreed to be
 * organized is a fresh mailbox, whose next screen is the consent statement and not a release.
 */
export function claimLeftBehind(m: {
  status?: string;
  organizerRole?: "organizer" | "reader";
  organizeConsentedAt?: string | null;
  /** The server's own comparison — see the header. Absent reads as NOT ours, the safe direction. */
  organizedByThisInstall?: boolean;
}): boolean {
  if (m.status !== "connected") return false;
  if (m.organizerRole !== "reader") return false;
  if (m.organizeConsentedAt === null || m.organizeConsentedAt === undefined) return false;
  return m.organizedByThisInstall === true;
}

/**
/**
 * ONE ROW, AS BOTH DERIVATIONS BELOW NEED TO SEE IT.
 *
 * Structural rather than `MailboxFacts`, on this file's standing rule: a derivation may consult
 * exactly the fields it names, so what a sentence is entitled to assert is readable from the
 * signature. Every member is optional because every one of them is a column some deployment
 * predates, and absent has an answer in each case that is stated where it is read.
 */
type OrganizerRow = Parameters<typeof readerStandDown>[0] & {
  id?: string;
  address?: string;
  organizedBy?: { kind: string | null; name: string | null; since: string | null } | null;
  organizerState?: "held" | "stopped" | null;
  organizerAcceptsRequests?: boolean;
  authKind?: string;
  organizerEventAt?: string | null;
  organizerEventSeenAt?: string | null;
};

/**
 * WHAT THE SCREENER CAN DO ON THIS INSTALL — three answers, and they are not two.
 *
 *  · `organizer` — this install organizes at least one live mailbox. Every verb works exactly as
 *    it always has, and nothing on the pane changes.
 *  · `pending` — every live mailbox belongs to somebody else, AND that somebody can take a
 *    decision made here and apply it on their own next pass. The decision bar stays: a press is
 *    real, it just does not land immediately, and the pane says who is going to land it.
 *  · `blocked` — every live mailbox belongs to somebody else and no decision made here has
 *    anywhere to go. The bar is WITHHELD and the pane names the way out.
 *
 * ── WHY THE THIRD STATE IS NOT A DISABLED VERSION OF THE SECOND ───────────────────────────────
 *
 * Because a control wired to a refusal is worse than an absent one, and this product has the
 * receipt. A released build drew the full decision bar on a mailbox it did not organize: the press
 * said "filed", the sender left the list and the count dropped — while nothing had happened on the
 * server. Forty-five seconds later the sender was back, marked "Not saved", with no sentence
 * saying why. The refusal has to be visible BEFORE the press, or it is not a refusal but a
 * rollback with an explanation nobody reads.
 *
 * ── WHY THE WHOLE ROSTER RATHER THAN ONE MAILBOX ──────────────────────────────────────────────
 *
 * The Screener's queue does not say which mailbox each sender belongs to, so a per-mailbox answer
 * has nothing to key on. Account-scoped configuration is permitted where the account holds at
 * least one organized mailbox, and a Screener decision writes a rule, so it is inside that set.
 * That is also the SAFE direction: with an organizer present nothing is refused, so a decision
 * that could have succeeded never is.
 *
 * The aggregation FLIPS for `pending`, and deliberately: every live reader must accept decisions
 * before the bar is offered, because one that does not is a sender whose press would be refused.
 * Permissive where refusing would cost a decision that works; conservative where offering would
 * cost a decision that does not.
 *
 * ── AND `live` FIRST, WHICH IS NOT COSMETIC ───────────────────────────────────────────────────
 *
 * A `disabled` row is a tombstone and KEEPS whatever role it had ({@link readerStandDown}'s own
 * first line). Counting it would let a mailbox somebody removed last week decide whether the
 * Screener works today. An empty roster answers `organizer` for the same reason a missing field
 * does everywhere on this surface: "we cannot see" is not "somebody else has it".
 */
export type ScreenerMode = "organizer" | "pending" | "blocked";

/**
 * WHY A DECISION HAS NOWHERE TO GO — the finer answer under {@link ScreenerMode} `blocked`.
 *
 *  · `organizer_outdated` — somebody holds the mailbox and their build cannot take a decision
 *    from a reader. The way out is to take the mailbox over, or to update that install.
 *  · `no_organizer` — nobody holds it at all. Nothing is filing this mailbox, which is a
 *    different sentence and a different remedy.
 *
 * The same two words the decision door answers with, so the pane and the refusal cannot come to
 * describe one state differently.
 */
export type ScreenerBlockReason = "organizer_outdated" | "no_organizer";

export interface ScreenerRole {
  mode: ScreenerMode;
  /**
   * The holder's own name for the copy, or `null` where the holder is real but this build has no
   * name for it — a claim written by a version that recorded none. `null` in `organizer`.
   */
  name: string | null;
  /** Only in `blocked`; `null` in the other two. See {@link ScreenerBlockReason}. */
  reason: ScreenerBlockReason | null;
  /**
   * EVERY live reader is signed in with OAuth — so the refusal is permanent for this release
   * rather than a build somebody can update.
   *
   * ALL of them, not any: on a mixed roster the sentence would name a limitation that does not
   * apply to some of these mailboxes, and a person reading it would conclude the wrong thing
   * about the password one. `false` in the other two modes and wherever this build cannot tell.
   */
  oauthOnly: boolean;
}

export function screenerMode(facts: ReadonlyArray<OrganizerRow> | null): ScreenerRole {
  const organizes: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
  if (facts === null) return organizes;
  const live = facts.filter((m) => m.status !== "disabled");
  if (live.length === 0) return organizes;
  /* `=== null` IS "THIS INSTALL ORGANIZES IT", and a RELEASED row is deliberately not that. It
     answers `released` — non-null — so a mailbox this account let go does not turn the Screener
     back on. Nothing files that mailbox, which is precisely what `no_organizer` below says. */
  if (live.some((m) => readerStandDown(m) === null)) return organizes;

  const named = live.map((m) => m.organizedBy?.name).find((n) => n && n.trim()) ?? null;
  /* `=== true` and never a truthy read: absent is "this build cannot tell", and the whole point of
     the field is that it withholds rather than offers. */
  if (live.every((m) => m.organizerAcceptsRequests === true)) {
    return { mode: "pending", name: named, reason: null, oauthOnly: false };
  }
  const oauthOnly = live.every((m) => m.authKind === "oauth");
  /* A HOLDER IS NAMED — the same test `readerStandDown` makes, and for the same reason: the object
     may exist with three nulls in it. Where no live row names anybody, nothing organizes these
     mailboxes at all, which is the other sentence and the other remedy. */
  const anyHolder = live.some((m) => Boolean(m.organizedBy && (m.organizedBy.kind || m.organizedBy.name)));
  return {
    mode: "blocked",
    name: named,
    reason: anyHolder ? "organizer_outdated" : "no_organizer",
    oauthOnly,
  };
}

/**
 * THE HOLDER, FOR A SURFACE THAT ASKS A TWO-WAY QUESTION — `null` where this install organizes.
 *
 * Several panes ask only "does this install organize these mailboxes, or read them?": the
 * install's own About and Desktop rows, and the screening preferences, whose stored values take
 * effect on a takeover and take effect on nothing before one. Both reader modes answer that
 * question identically — a `pending` reader still moves no mail here — so narrowing at the read
 * is the honest shape rather than a lossy one.
 *
 * It exists so the narrowing is written ONCE. A surface that wrote `role.mode !== "organizer"`
 * inline would be one edit away from accidentally treating `pending` as organizing on the day
 * somebody adds a fourth mode.
 */
export function readerHolder(role: ScreenerRole): { name: string | null } | null {
  return role.mode === "organizer" ? null : { name: role.name };
}

/**
 * MAY THESE MAILBOXES BE WRITTEN TO FROM HERE — the sentence to say, or `null` for yes.
 *
 * ══ ONE PREDICATE, TWO LANES ══════════════════════════════════════════════════════════════
 *
 * The single-message verbs (Backspace/Delete) and the bulk verbs over a selection ask the same
 * question about different numbers of mailboxes, so they ask it here. The single-message arm
 * passes `[m.mailboxId]` rather than a scalar, deliberately: one code path, and a selection
 * spanning two mailboxes cannot take a route the single press has never been down.
 *
 * ══ WHY IT TAKES THE RAW ROSTER AND NOT A RESOLVED ROLE ═══════════════════════════════════
 *
 * Because the only resolved role on this surface is `screenerMode`'s, and it is the WRONG one.
 * That derivation aggregates the whole roster and is deliberately permissive — "with an organizer
 * present nothing is refused, so a decision that could have succeeded never is" — which is correct
 * for the Screener, whose queue does not say which mailbox a sender belongs to and whose decision
 * writes an ACCOUNT-scoped rule. Handing it a message verb produced a concrete defect: an account
 * organizing mailbox A and reading mailbox B answered `organizer`, so Delete on B's mail was
 * offered, held, hidden and dispatched, and only the server's own per-mailbox
 * `assertOrganizerRole` rolled it back — the control-wired-to-a-refusal shape `ScreenerMode`'s
 * third state was invented to end, reintroduced one verb over. Found by review, 2026-09-06.
 *
 * So nothing is aggregated. Each named mailbox is looked up in the roster and judged on its own
 * row, and the FIRST one that refuses supplies the sentence — list order, so the answer is stable
 * across repeated calls and a caller can put the mailbox it cares about first.
 *
 * ══ AND AN UNKNOWN ROSTER REFUSES, BECAUSE THESE VERBS FAIL CLOSED ════════════════════════
 *
 * Everywhere else on this surface an absent fact reads as `organizer` — "a host that does not send
 * the column has not demoted anybody", and the dangerous default there is the other one, which
 * would hang a claim banner over a mailbox this machine already organizes. A WRITE inverts that
 * calculus: refusing an organizer for the second it takes the roster to arrive costs a sentence;
 * permitting a reader moves mail on somebody else's server. The roster is `null` before the first
 * probe answers and stays `null` through an outage, so the window is real, not theoretical.
 *
 * Four things therefore refuse: a roster still PENDING, an empty `mailboxIds`, an id no live row
 * carries, and a row this install reads rather than organizes. The first three have no holder to
 * name and take `say.unknown()`, which claims no particular install — the honest sentence when the
 * answer is "not from here" and nothing more is known.
 *
 * A shell with NO PROBE AT ALL permits, and that is not a hole: see the `absent` arm below.
 *
 * A `disabled` row is skipped as unknown rather than read: it is a tombstone that KEEPS whatever
 * role it had ({@link readerStandDown}'s own first line), and nothing should be written to a
 * mailbox that has been removed.
 */
export type RosterState =
  /** This shell was given no probe: the desktop, the demo. There is no roster and never will be. */
  | { kind: "absent" }
  /** A probe exists and has not answered — mid-first-poll, or an outage. */
  | { kind: "pending" }
  | { kind: "known"; rows: ReadonlyArray<OrganizerRow> };

/** Build the state from the provider's two fields. One place, so the collapse cannot come back. */
export function rosterStateOf(
  probed: boolean,
  facts: ReadonlyArray<OrganizerRow> | null,
): RosterState {
  if (!probed) return { kind: "absent" };
  return facts === null ? { kind: "pending" } : { kind: "known", rows: facts };
}

export function readerMoveRefusal(
  roster: RosterState,
  mailboxIds: ReadonlyArray<string>,
  say: { named: (name: string) => string; unknown: () => string },
): string | null {
  /* NO PROBE, NO GATE. On a door with no roster the wire has always been the only authority, and
     it still is — the server refuses a reader's delete with `assertOrganizerRole` exactly as
     before this predicate existed. A press-time refusal is an IMPROVEMENT where a roster exists;
     it must not become a new gate where none does. Refusing here made every delete on the desktop
     and in the demo fail with a sentence naming another install, which is false on both. */
  if (roster.kind === "absent") return null;
  /* PENDING IS A REFUSAL, and it is the arm the original rule was written for: the answer is
     coming, the verb is destructive, and a second's wait costs a sentence while a wrong permit
     costs mail moved on somebody else's server. */
  if (roster.kind === "pending") return say.unknown();
  const facts = roster.rows;
  if (mailboxIds.length === 0) return say.unknown();
  for (const id of mailboxIds) {
    const row = id ? facts.find((m) => m.id === id && m.status !== "disabled") : undefined;
    if (!row) return say.unknown();
    if (readerStandDown(row) === null) continue;
    const name = row.organizedBy?.name && row.organizedBy.name.trim() ? row.organizedBy.name : null;
    return name ? say.named(name) : say.unknown();
  }
  return null;
}

/**
 * WHAT CHANGED ABOUT WHO ORGANIZES THESE MAILBOXES, AND HAS NOT BEEN ACKNOWLEDGED YET.
 *
 * One entry per mailbox whose `organizerEventAt` is newer than its `organizerEventSeenAt`. The
 * comparison is the whole mechanism, and it is deliberately two instants rather than a flag:
 *
 *  · ONCE PER CHANGE, ON EVERY DOOR. Every client computes the same predicate from the same two
 *    instants, so an acknowledgement on the phone removes the line in the browser on its next
 *    poll. A per-client flag shows one change once per client, which is the same sentence three
 *    times.
 *  · TWO CHANGES BETWEEN TWO READS COLLAPSE TO ONE LINE. There is no queue to drain, so a mailbox
 *    that changed hands twice while nobody looked produces one line describing where it ended up
 *    — the only statement still true.
 *  · AN ACKNOWLEDGEMENT CANNOT SUPPRESS A LATER CHANGE. It answers the change that stood when the
 *    press happened, and nothing after it.
 *
 * ── WHAT IS WITHHELD, AND WHY EACH ────────────────────────────────────────────────────────────
 *
 * A tombstone: a mailbox somebody removed is not news about organizing. An absent or unparseable
 * instant: "this build cannot tell" must not become a sentence about a machine that never changed
 * hands. And a reader with no holder that nobody has ever agreed to organize — that is an ordinary
 * freshly connected mailbox, and its next screen is the agreement, not a notice.
 *
 * Ordered newest change first, so a slot with room for one line carries the most recent.
 */
export type OrganizerNoticeKind = "elsewhere" | "stopped" | "here" | "released";

export interface OrganizerNotice {
  /** The mailbox the line is about — the id the acknowledgement is sent for. */
  id: string;
  /** Its address: the line names the mailbox, and a roster may hold several. */
  address: string;
  kind: OrganizerNoticeKind;
  /** The holder's name, on the two kinds that have one. `null` otherwise. */
  name: string | null;
  /** `organizerEventAt`, so a caller can order or date the line. */
  at: string;
}

export function organizerNotices(facts: ReadonlyArray<OrganizerRow> | null): OrganizerNotice[] {
  if (facts === null) return [];
  const out: OrganizerNotice[] = [];
  for (const m of facts) {
    if (m.status === "disabled") continue;
    const at = m.organizerEventAt;
    if (at === null || at === undefined) continue;
    const when = Date.parse(at);
    if (!Number.isFinite(when)) continue;
    /* A NULL OR ABSENT `seenAt` IS "NEVER ACKNOWLEDGED", which shows the line. An UNPARSEABLE one
       is not: a stamp this build cannot read is no evidence the change was never seen, and
       treating it as such would re-show a line somebody has already dismissed, on every poll. */
    const seenRaw = m.organizerEventSeenAt;
    if (seenRaw !== null && seenRaw !== undefined) {
      const seen = Date.parse(seenRaw);
      if (!Number.isFinite(seen)) continue;
      if (when <= seen) continue;
    }
    const kind = noticeKind(m);
    if (kind === null) continue;
    out.push({
      id: m.id ?? "",
      address: m.address ?? "",
      kind,
      name: kind === "elsewhere" || kind === "stopped"
        ? (m.organizedBy?.name && m.organizedBy.name.trim() ? m.organizedBy.name : null)
        : null,
      at,
    });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** Which of the four sentences one row is in, or `null` for a row with nothing to announce. */
function noticeKind(m: OrganizerRow): OrganizerNoticeKind | null {
  /* ABSENT READS AS ORGANIZER, the same default the role carries everywhere on this surface: a
     host that does not send the column has not demoted anybody. */
  if (m.organizerRole !== "reader") return "here";
  const holder = Boolean(m.organizedBy && (m.organizedBy.kind || m.organizedBy.name));
  if (holder) return m.organizerState === "stopped" ? "stopped" : "elsewhere";
  /* NO HOLDER, AND NOBODY EVER AGREED — an ordinary freshly connected mailbox, whose next screen
     is the agreement rather than a notice about a handover that never happened. `=== null` and
     not `== null`, so an absent stamp (a build that cannot tell) says nothing. */
  if (m.organizeConsentedAt === null || m.organizeConsentedAt === undefined) return null;
  /* ── NO HOLDER, CONSENTED: TWO STATES, AND ONLY THE MARKER TELLS THEM APART ────────────────
   *
   * This line answered `released` for both of them, and one of the two is not a release. The
   * per-cycle peek rewrites all four holder columns and writes them ALL NULL when it finds an
   * empty claim folder — so a stand-down whose winner was removed DECAYS into this exact shape,
   * with nobody having released anything. Worse, the same write stamps `organizer_event_at` on a
   * flip in either direction INCLUDING to and from NULL, so the decayed row arrives here with a
   * fresh unacknowledged event and the line fires on it: "You stopped organizing … here", about
   * something the person never did.
   *
   * So `released` needs the marker `readerStandDown` keys on, and the decayed row gets the
   * sentence that is true of it — organizing here has stopped and nobody known holds it, which is
   * `stopped` with no name. That is the ONE open condition of the four: nothing files this
   * mailbox, and mail accumulates unsorted while it is true, which is precisely the decayed row's
   * situation and worth the emphasis the sentence carries. `organizerNotices` withholds the name
   * for a row with no named holder already, so the unknown-holder wording is reached by the same
   * rule that serves a stopped holder whose claim recorded no name. */
  return m.organizerReleasedAt !== null && m.organizerReleasedAt !== undefined
    ? "released"
    : "stopped";
}

/**
 * ONE mailbox, as the shared shell is allowed to know it.
 *
 * Structural and shell-owned, NOT `MailboxDTO`. The Cloud client's API layer is not part of the
 * Desktop app, so this file may not name its types; and narrowing to the fields the
 * ladder reads is the honest declaration of what the derivation is entitled to consult.
 * Anything the Cloud client can see and this interface does not name is a fact the copy may
 * not assert.
 */
export interface MailboxFacts {
  /**
   * WHICH mailbox this is — added for the From seam, NOT for the ladder.
   *
   * `deriveMailState` must never read it, and does not: every state below is about the account
   * or about one mailbox already in hand, and an id is not a fact any sentence can assert. It
   * is here because `compose-from.ts` needs a stable, non-address handle — the From selector's
   * value is a mailbox id and never an address string, so that an alias landing later cannot
   * turn one address into two mailboxes' worth of ambiguity.
   */
  id: string;
  address: string;
  /**
   * The mailbox's user-facing label from `GET /mailboxes` — what the "me" recipient chip wears
   * as the account's name (viewer redesign). `deriveMailState` must never read it, and does not: a
   * label says nothing about whether mail is arriving. OPTIONAL and nullable because the wire
   * is (`MailboxDTO.displayName` — OAuth connects fill it from the provider, IMAP connects only
   * when the user typed one), and the chip's fallback for both absences is the bare address.
   */
  displayName?: string | null;
  /** The 3-member lifecycle union, widened to `string` because the wire is a string. */
  status: string;
  /** Null unless `status === 'error'`. A stable key; the wording lives in `messages/*.json`. */
  errorCode: string | null;
  /**
   * WHY a `disabled` mailbox is disabled, when the ORGANIZER LEASE decided it (mail 0027).
   *
   * The raw wire token, colon and all — {@link standDownToken} is what turns it into copy. Null
   * is the ordinary disconnect, and under `status === 'disabled'` that distinction is the whole
   * of what separates "you removed this" from "somebody else has claimed it".
   */
  disabledReason: string | null;
  /** WHY a `connected` mailbox is not being synced (mail 0029). Null is the healthy case. */
  syncBlockedReason: string | null;
  /** When the CURRENT block began. `coalesce`d server-side, so it does not restart per pass. */
  syncBlockedSince: string | null;
  /** End of a completed worker cycle. Read ONLY as `=== null`. See the header. */
  lastSyncAt: string | null;
  /**
   * When this mailbox's FIRST import finished, or null while it has not (mail 0038). The one
   * server stamp this module reads — per-mailbox, not shared; late, not early — read as a floor
   * and only as `=== null`. Its third failure mode is the bound's reason: the write needs a
   * no-backlog cycle, which is not guaranteed, and a mailbox that never got one held a
   * permanent "Syncing your mail" ({@link importFloorSpeaks}). OPTIONAL is the whole
   * distinction: an older server omits the field, which must reach the ladder as `undefined`,
   * never `null` — a `?? null` at the probe would read every non-empty mirror as "still
   * importing" for ever. `CloudShell` forwards the field untouched.
   */
  initialImportCompletedAt?: string | null;
  /**
   * Who organizes this mailbox — `organizer` is this install, `reader` is
   * somebody else's. Optional; absent reads as `organizer` everywhere:
   * every install was one before the column existed, and a host that does
   * not send it cannot have demoted anybody — the dangerous default is the
   * other one, a claim banner over a mailbox this machine already
   * organizes. `organizedBy.since` is when that install BECAME organizer,
   * not last-seen — a banner says "since Tuesday", never a heartbeat.
   * `organizerState` is whether the holder still renews; `stopped` turns the banner from a fact into a problem.
   */
  organizerRole?: "organizer" | "reader";
  organizedBy?: { kind: string | null; name: string | null; since: string | null } | null;
  organizerState?: "held" | "stopped" | null;
  /**
   * A stand-down as a pre-role engine reports one — `disabled` with a
   * reason and no `organizerRole` at all. Computed at the wire seam because
   * only there is the ABSENCE of the role still visible: the mapper coerces
   * an absent role to `organizer` (the safe default), which erases exactly
   * this signal. It exists so a window newer than its engine does not
   * silently withdraw the only exit from a stand-down: the claim predicate
   * is written against the new vocabulary, and a legacy row satisfies none
   * of it.
   */
  legacyStandDown?: boolean;
  /**
   * When somebody agreed to let ohmail organize this mailbox, `null` for "nobody has", ABSENT
   * for "this build cannot tell" — three states, and the third is not the second. It sits
   * beside `organizerRole` because the pair cannot collapse: a browser-connected mailbox is a
   * reader never agreed to (needs the agreement screen); a displaced organizer is a reader that
   * HAS been (must never see it again) — and `organizedBy` cannot tell them apart.
   * `deriveMailState` never reads it. Every reader tests `=== null`: read `== null`, an absent
   * field would offer a claim on every mailbox of every older deployment.
   */
  organizeConsentedAt?: string | null;
  /**
   * When the organizing situation last changed, and when somebody last
   * acknowledged it. Two instants rather than a flag; the notice is
   * `eventAt > seenAt`, computed here — which makes the line appear once
   * per change rather than once per client: a phone, a browser and a
   * desktop reading one row agree, and a dismissal on any travels to the
   * others on their next poll. Two changes between reads collapse to the
   * later one, the only statement still true. Absent is "this build cannot
   * tell" and withholds the notice — the safe direction.
   */
  organizerEventAt?: string | null;
  organizerEventSeenAt?: string | null;
  /**
   * WHEN THIS INSTALL LET THIS MAILBOX GO ON PURPOSE, or `null`.
   *
   * The one thing that separates a mailbox somebody released from a mailbox whose holder simply
   * vanished — both are readers with no holder, and only one of them is something the person at
   * this screen did. Read for the pane's permanent line and for nothing else.
   */
  organizerReleasedAt?: string | null;
  /**
   * THE STANDING ASK TO STOP ORGANIZING THIS MAILBOX HERE, or `null` — pending until the
   * organizer's own pass confirms the record out of the mailbox (or the wait ends at the
   * record's own expiry). While it stands, the row is still an ORGANIZER and files nothing:
   * without this field that whole window renders as an ordinary organized mailbox, and on a
   * server that keeps refusing the confirmation the person's press shows no trace at all.
   *
   * ABSENT is an older server and withholds the sentence — the ordinary organized description
   * stands, which is what such a server actually reports.
   */
  releaseRequestedAt?: string | null;
  /**
   * THE STANDING PRESS TO ORGANIZE THIS MAILBOX HERE, or `null` — the takeover's pending half,
   * spent by the gate's next pass. Read to END a pane's own "asked for" note once the row has
   * answered, rather than showing it for ever. ABSENT is an older server and changes nothing.
   */
  takeoverAuthorizedAt?: string | null;
  /**
   * Would a decision made here be accepted by whoever organizes this
   * mailbox? `true` only where a press has somewhere to go. Absent and
   * `false` both mean it has not, deliberately undistinguished: an older
   * server that cannot answer and a holder that cannot accept produce the
   * same screen — withhold the controls and name the way out. The dangerous
   * default is the other one: a `true` draws a decision bar whose every
   * press ends in a refusal, the shape that once let this product say
   * "filed" and take it back a minute later.
   */
  organizerAcceptsRequests?: boolean;
  /**
   * How this mailbox is signed in — and it decides one sentence, not one
   * control. A password mailbox lets both installs derive the same signing
   * key, so an organizer can tell a reader's decision from a stranger's;
   * an OAuth mailbox has no shared secret, so a reader's decision is
   * refused however new both installs are — a property of the sign-in, not
   * version skew, and the pane says it plainly instead of implying a wait.
   * Absent says nothing, which is right for a build that cannot tell.
   */
  authKind?: "password" | "oauth";
  /**
   * How many of the user's own filings this mailbox has not applied yet. The API never opens
   * IMAP: a decision writes `folder_state` and the worker moves the mail — a window that does
   * not close when the mail host refuses connections, and nothing else on the row notices
   * (still `connected`, `syncBlockedSince` null), so the strip said nothing while a backlog of
   * the user's own decisions grew. Optional, read with `typeof === "number"` ({@link
   * initialImportCompletedAt}'s rule): `undefined` means "this build cannot tell", never `0`.
   * The arm also tests `> 0` — "Filing 0 messages" is a sentence about nothing.
   */
  pendingMoves?: number;
  /**
   * THE SAME OUTSTANDING FILINGS, SPLIT BY THE OPERAND THAT DECIDES — see {@link FilingFacts}.
   *
   * OPTIONAL on {@link pendingMoves}' rule and read with a presence test, never `?? {}`: ABSENT is
   * a server older than the field, and the arm then runs on the legacy count alone and produces
   * exactly the sentence it always produced. Inventing zeros here would report "nothing is
   * deferred" about a deployment that never said.
   */
  filing?: FilingFacts;
  /**
   * How much mail the server says is in this mailbox — the first pull's denominator (mail
   * 0083), Σ `mailbox_folders.server_exists` over opened folders. `deriveMailState` never reads
   * it: the strip is about whether mail is arriving; this is how much is still to come, asked
   * only by the first-run pull screen. Optional, `typeof === "number"`, never `?? 0`: absent is
   * "no folder carries a count yet", and a `0` in its place claims the person's mail server
   * holds nothing. It grows while the first cycle walks the tree and may sit below the mirror's
   * own count, so every consumer clamps the remainder at zero.
   */
  serverMessageCount?: number;
  /**
   * The biggest message this mailbox's submission server said it will accept, in bytes — its
   * own `SIZE` announcement, recorded at connect. `deriveMailState` never reads it; it is here
   * because `compose-from.ts` needs it and this is the narrowed shape `GET /mailboxes` arrives
   * as. Optional AND nullable, two different things ({@link
   * MailboxFacts.initialImportCompletedAt}'s rule): absent is an API predating the column,
   * `null` is a server that announced no ceiling. Both fall back to the product constant at the
   * compose surface; the distinction is kept because collapsing it once broke the import floor.
   */
  smtpMaxSizeBytes?: number | null;
  /**
   * Why sending is not set up for this mailbox — the probe's own reason, or
   * `null`/absent when it is. An outgoing server is not a reason to stop
   * receiving: the local door stores the incoming credential when only the
   * submission dial is refused, records the reason here, and the send path
   * refuses with it rather than guessing. Every surface that mentions it
   * reads THIS field, so the pane, the setup summary and the send refusal
   * cannot say three different things. `null` is "settled" — proof the
   * submission server answered when the password was stored, not a promise about tomorrow.
   */
  sendingUnsettledReason?: string | null;
  /**
   * How many messages the ACCOUNT holds for this mailbox — the server's count, not this device's.
   * The reader's question is a comparison: the numerator is {@link MailStateInputs.mirrored}, this
   * is the denominator. Two consumers, neither an alarm: the `importing` arm quotes the pair as
   * progress; the Mailboxes pane states it at rest ({@link deviceHoldings} — the `behind` strip
   * state was removed 2026-08-30). Not `messageCount`, which on a local engine is the MIRROR's own
   * count — a comparison of a number against itself. Optional, `typeof === "number"`: absent means
   * "cannot tell", never `0` — a `?? 0` would make an unknowable denominator look like an emptied
   * account. The hosted client never sends it.
   */
  hostedMessageCount?: number;
  /**
   * The forwarding-detection notice's evidence pair (mail 0078). `inboundQuietSince` non-null
   * is a standing quiet episode: the worker judged this connected, healthily-syncing mailbox to
   * have received essentially no genuine inbound for a generous window ("almost nothing since
   * {this}"); `inboundQuietDismissedAt` is the mailbox's dismissal. `deriveMailState` never
   * reads them: the feature is a quiet note on the Mailboxes pane, and a strip state would be
   * the alarm the copy exists not to be. Optional; absent means the engine or API predates the
   * columns — forwarded untouched, no `?? null`.
   */
  inboundQuietSince?: string | null;
  inboundQuietDismissedAt?: string | null;
  /** When this mailbox was connected. The one per-mailbox clock that is not shared. */
  createdAt: string;
}

/**
 * Whether the forwarding-detection notice shows on a mailbox row (mail
 * 0078). Exported pure so the suite can bite each clause; in the shared
 * shell because two panes render it — one rule, or two surfaces tell one
 * owner two stories. Three gates: `inboundQuietSince` set (the worker's
 * pass is the predicate's single owner); the mailbox healthy ON SCREEN
 * (connected, unblocked, synced, FRESH — `now` is a parameter; health gates
 * hide, never reset); and not dismissed, or dismissed before this
 * episode's evidence (`dismissedAt < since`, via `Date.parse`, never string order).
 */
export const INBOUND_QUIET_SHOW_FRESH_MS = 24 * 60 * 60 * 1000;

export function showInboundQuiet(m: {
  status: string;
  lastSyncAt: string | null;
  syncBlockedSince?: string | null;
  inboundQuietSince?: string | null;
  inboundQuietDismissedAt?: string | null;
}, now: number): boolean {
  if (!m.inboundQuietSince) return false;
  if (m.status !== "connected" || m.lastSyncAt === null || m.syncBlockedSince) return false;
  if (now - Date.parse(m.lastSyncAt) > INBOUND_QUIET_SHOW_FRESH_MS) return false;
  if (!m.inboundQuietDismissedAt) return true;
  return Date.parse(m.inboundQuietDismissedAt) < Date.parse(m.inboundQuietSince);
}

/**
 * The account's own message total, summed over the mailboxes that can be behind — or `null`.
 * Every-or-nothing is the load-bearing half: a partial sum is not a smaller total, it is a
 * WRONG one ("1,114 of 20,000" while the truth is 34,000), so one missing answer withdraws the
 * whole claim. Summed over every mailbox the facts carry, connected or not, because the
 * numerator is the whole mirror and a disconnected mailbox's mail stays in it — summing only
 * connected rows compares two different populations (an earlier version did exactly that). A
 * mailbox the account no longer names reports no count, which withdraws the denominator by the
 * same rule.
 */
export function hostedTotal(mailboxes: readonly MailboxFacts[]): number | null {
  if (mailboxes.length === 0) return null;
  let sum = 0;
  for (const m of mailboxes) {
    if (typeof m.hostedMessageCount !== "number") return null;
    sum += m.hostedMessageCount;
  }
  return sum;
}

/**
 * What this device holds, against what the account holds — the pair, or `null` when no sentence may quote
 * one. Not an alarm, and it used to be: the `behind` strip state was removed because a difference between the
 * two numbers is the NORMAL shape of a windowed mirror in front of working reach-past doors, the arm could
 * not tell a healthy window from a stalled one, and the banner contradicted its own destination ("Up to
 * date"). The fact moved to a quiet line in the Mailboxes pane, and this is that line's one derivation — also
 * what the `importing` arm quotes. `null` in three say-nothing cases: facts not visible yet; {@link
 * hostedTotal} withheld the denominator; or the total is not STRICTLY above `mirrored` (a passed denominator
 * is a stale reading — stop quoting, never clamp).
 */
export interface DeviceHoldings {
  /** Messages in the local mirror — every folder, every mailbox. */
  count: number;
  /** Messages the hosted account holds. Strictly greater than {@link DeviceHoldings.count}. */
  total: number;
}

export function deviceHoldings(
  mailboxes: readonly MailboxFacts[] | null,
  mirrored: number,
): DeviceHoldings | null {
  if (mailboxes === null) return null;
  const total = hostedTotal(mailboxes);
  if (total === null || total <= mirrored) return null;
  return { count: mirrored, total };
}

/**
 * May the holdings sentence be said at all right now? — the gate in front of {@link deviceHoldings}, a separate
 * question from the arithmetic. Two findings: a mirror nobody has read yet (`bootstrapping` — the engine fills page
 * by page while the probe answers on the first tick, so a cold launch read "holds 0 of N" over a full store), and a
 * loop that cannot keep the promise — the sentence says the rest loads when reached, and both reach-past doors are
 * network reads. {@link HOLDINGS_SILENT_KEYS} is four keys: `stopped`, `failing`, `stale` (on the desktop the
 * SIDECAR's own stamp — the offline case), `catchingUp`. This differs from {@link MailState.settled}, which admits
 * stopped/failing on purpose: "the list is empty" stays true on a dead loop, "the rest will load" does not. Written
 * against the ladder's VERDICT; exported pure.
 */
export const HOLDINGS_SILENT_KEYS: readonly MailStateKey[] = [
  "stopped", "failing", "stale", "catchingUp",
];

export function holdingsSpeak(
  state: MailState,
  /**
   * The same freshness verdict the ladder judged — the desktop's probed
   * one, the sidecar's stamp against the hosted account. A third gate, and
   * the one the key list cannot express: `unknown` is not a key — the
   * stale arm does not fire for it — so a door whose freshness was never
   * established falls through to `quiet` and `settled` can be true on
   * nothing more than "this client's first drain finished"; exactly a
   * desktop whose `/mirror/freshness` hangs while the local feed serves
   * perfectly. A promise about on-demand loading is made from evidence only, so `unknown` is silence.
   */
  freshness: { state: "unknown" | "stale" | "current" },
): boolean {
  return state.settled
    && freshness.state === "current"
    && !HOLDINGS_SILENT_KEYS.includes(state.key);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   IS THE MIRROR GROWING? — a pure reducer over two or more observations
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * How long a rise keeps counting, and how close two rises must be to be
 * one run. Thirty seconds: it must survive one missed 8 s poll plus
 * backoff jitter plus a worker writing in batches — a one-poll window
 * would flap between "syncing" and silence — and stay far below "finished
 * three hours ago". A duration, not a poll count (a count silently retunes
 * when `POLL_MS` changes). It bounds the RUN, not the episode: the gap
 * that governs mid-import is the SERVER's ~60 s cycle, which no 30 s
 * window can span — that is {@link IMPORT_END_IDLE_MS}'s job.
 */
export const GROWTH_WINDOW_MS = 30_000;

/**
 * How long an import EPISODE survives a mirror that is not moving. Observed: three worker drains with
 * 45 s idle between them showed the strip five times in one import — every gap outlived {@link
 * GROWTH_WINDOW_MS} and ended the run. Ninety seconds: the mid-import gap is one server cycle (default
 * 60 s) plus up to one 8 s client poll (~68 s floor; largest measured gap 45 s), and
 * `test/mail-state.test.ts` asserts the relation against the server's own constant. The cost, said out
 * loud: the strip lingers up to 90 s after the last message — accepted, because there is no
 * end-of-import signal to replace it (`lastSyncAt` cannot be read positively; `/sync` answers per
 * drain). A stale-but-true tail beats a strip appearing five times.
 */
export const IMPORT_END_IDLE_MS = 90_000;

/**
 * How much a run of rises must add before it is called an import rather
 * than the post. Without it the strip appears for one decay window every
 * busy morning, for ever — the permanent chrome `SyncBar.tsx` was built to
 * avoid. Twenty-five messages is crossed in ~19 s at the measured import
 * rate and is not crossed by a thread burst. Measured against
 * {@link MirrorGrowth.added} — what the run ADDED — not `count -
 * runStartCount`, a net delta a single delete could walk back. A first
 * import from an EMPTY mirror does not have to reach it ({@link isImporting}).
 */
export const IMPORT_MIN_DELTA = 25;

/**
 * What the sampler remembers. Two observations are the minimum evidence for "growing", so a
 * single arrival can never make the claim.
 */
export interface MirrorGrowth {
  /** The last count observed. */
  count: number;
  /** When the count last ROSE. `-Infinity` until it ever has — never `Date.now()`. */
  lastRiseAt: number;
  /** Rises in the CURRENT run. `growing` needs two; one rise is an arrival, not an import. */
  rises: number;
  /** The count this run started from. Zero means "this mirror was empty", i.e. a first import. */
  runStartCount: number;
  /**
   * Messages the current run has ADDED. Cumulative, never reduced: the
   * qualifier used to be `count - runStartCount`, a net delta, and a fall
   * moves `count` while leaving `runStartCount` alone — so every delete and
   * every Screener-backfill move SHRANK the evidence, and the strip
   * followed the delta back and forth across {@link IMPORT_MIN_DELTA} for
   * as long as the backfill ran. `added === count - runStartCount` exactly
   * when no fall happened in the run — asserted, not asserted-in-a-comment.
   */
  added: number;
  /**
   * The episode latch. True from the moment a run first qualifies as an import until the mirror
   * is still for {@link IMPORT_END_IDLE_MS} — deliberately NOT cleared when a run ends: both
   * qualifiers are effectively single-use in a session (`runStartCount === 0` only holds before
   * the first gap; `bootstrapping` never returns), so without a latch an import that pauses 31
   * s re-earns two rises and twenty-five messages before speaking — five times in one measured
   * import. A boolean, not a timestamp: nothing reads WHEN the episode began, and a field
   * nobody reads is a claim under test that fails.
   */
  importing: boolean;
}

/**
 * The seed. `lastRiseAt: -Infinity`, not `Date.now()`: the mirror persists
 * into IndexedDB, so a tab opening onto a settled mailbox starts at 495
 * rather than 0, and seeding "now" would make the next arrival look like
 * the second rise of a run that never had a first — every reload of a
 * healthy mailbox would announce an import. `importing: false` for the
 * same reason, the one place the latch does not survive: a tab opening
 * mid-import cannot tell itself from one opening onto a settled mailbox,
 * so it claims nothing; it re-enters via `bootstrapping`, then needs {@link IMPORT_MIN_DELTA} to latch.
 */
export function seedGrowth(count: number): MirrorGrowth {
  return {
    count,
    lastRiseAt: -Infinity,
    rises: 0,
    runStartCount: count,
    added: 0,
    importing: false,
  };
}

/**
 * Fold one observation of the mirror's size in.
 *
 * A FALL — a delete, a move out of the mirror — moves the baseline and touches nothing else.
 * It is not a rise, and it is not evidence that the previous rise did not happen. That was
 * already true and already deliberate; what changed is that it now MATTERS, because `added`
 * is the qualifier and a fall may not reduce it.
 */
export function growthStep(prev: MirrorGrowth, count: number, now: number): MirrorGrowth {
  if (count === prev.count) return prev;
  if (count < prev.count) return { ...prev, count };
  const continues = now - prev.lastRiseAt <= GROWTH_WINDOW_MS;
  const rises = continues ? prev.rises + 1 : 1;
  // A new run starts from the count BEFORE this rise — so a run that begins on an empty
  // mirror has `runStartCount === 0`, which is what identifies a first import.
  const runStartCount = continues ? prev.runStartCount : prev.count;
  const added = (continues ? prev.added : 0) + (count - prev.count);
  // THE EPISODE OUTLIVES THE RUN. A 31 s gap ends the run — it is longer than GROWTH_WINDOW_MS —
  // and must not end the import, because the worker's cycle is 60 s and a gap of that size is
  // simply what the middle of an import looks like from a client that can only see its mirror.
  const held = prev.importing && now - prev.lastRiseAt < IMPORT_END_IDLE_MS;
  const qualifies = rises >= 2 && (runStartCount === 0 || added >= IMPORT_MIN_DELTA);
  return { count, lastRiseAt: now, rises, runStartCount, added, importing: held || qualifies };
}

/**
 * Two rises, the second of them recent. Nothing else counts as growth.
 *
 * It is the ENTRY evidence, and {@link isImporting} bypasses it entirely once an episode has
 * latched — which is the most surprising line in this file, so it is said in both places. A
 * latched episode is not required to keep proving that the mirror is growing right now; it is
 * required only not to have been still for {@link IMPORT_END_IDLE_MS}.
 */
export function isGrowing(g: MirrorGrowth, now: number): boolean {
  return g.rises >= 2 && now - g.lastRiseAt < GROWTH_WINDOW_MS;
}

/**
 * Is this growth an import worth interrupting the screen for? Two ways in, all client facts. 1:
 * the episode is latched — {@link growthStep} set it when a run first qualified (an
 * empty-mirror start, or {@link IMPORT_MIN_DELTA} added); the only question here is whether the
 * mirror has been still for {@link IMPORT_END_IDLE_MS} — qualifiers are evaluated once, never
 * re-litigated between worker cycles. 2: this tab's first drain has not completed — true for
 * seconds, covers the cold-start window, cannot latch and does not need to. Neither reads a
 * server timestamp; that rule is why the import FLOOR is a separate arm in {@link
 * deriveMailState}, not a third way in here.
 */
export function isImporting(g: MirrorGrowth, bootstrapping: boolean, now: number): boolean {
  if (g.importing) return now - g.lastRiseAt < IMPORT_END_IDLE_MS;
  return isGrowing(g, now) && bootstrapping;
}

/**
 * How long the import floor is trusted with no corroboration. Twenty-four
 * hours; the number's job is to DOMINATE any genuine first import rather
 * than estimate one — the measured scale is a first attach at ~6 minutes
 * (twice), thousands of messages drained in minutes, attaches serial so a
 * second mailbox waits with nothing stamped. A day is an order of
 * magnitude past all of it, which is what makes the window safe to treat
 * as absolute: inside it the floor is obeyed exactly as before the bound
 * existed. Exported so a test can drive either side.
 */
export const IMPORT_FLOOR_MAX_MS = 86_400_000;

/**
 * Does the server's unwritten stamp still entitle the strip to say "importing" about THIS mailbox? The stamp is written only
 * by a no-backlog cycle, which nothing guarantees: a mailbox observed four days unstamped kept a permanent "Syncing" over a
 * drained, motionless mirror, and the floor's `some` spread it to a healthy sibling. A null is an unknown, and an unknown that
 * has outlived every plausible import is not grounds for a claim about work in flight. Inside {@link IMPORT_FLOOR_MAX_MS} the
 * floor is absolute; past it, corroboration — `!bootstrapping` (a completed full drain) AND `failures === 0` (a frozen mirror
 * during failures is a broken instrument, not a reading) AND a still `lastRiseAt`. A real import past the window re-enters
 * through the growth arm, which outranks this. Taken as the struct, not a pre-computed boolean: a bare `drained` parameter is
 * invertible at the call site with both polarities green.
 */
export function importFloorSpeaks(
  mailbox: MailboxFacts,
  growth: MirrorGrowth,
  sync: { bootstrapping: boolean; failures: number },
  now: number,
): boolean {
  // `!== null` and not `!= null`, which is the deploy-skew rule the header and {@link
  // MailboxFacts.initialImportCompletedAt} both turn on: a server older than the column omits the
  // field, it arrives as `undefined`, and `undefined !== null` is true — so an absent stamp leaves
  // this function immediately and the ladder degrades to growth-only rather than announcing a
  // false import over every settled mailbox on the account.
  if (mailbox.initialImportCompletedAt !== null) return false;

  // Inside the window the floor is absolute. `Number.isFinite` fails for an unparseable or absent
  // `createdAt`, and that case DELIBERATELY takes the corroborated path below rather than the
  // absolute one: the alternative is a mailbox whose clock cannot be read holding a permanent
  // banner, which is the defect this function exists to remove, and the corroboration is what
  // makes skipping the window safe. Pinned by a test so it stays a decision rather than an
  // accident of `now - NaN < bound` evaluating false.
  const connectedAt = new Date(mailbox.createdAt).getTime();
  if (Number.isFinite(connectedAt) && now - connectedAt < IMPORT_FLOOR_MAX_MS) return true;

  // Past the window the client must have something of its own to say. It has not drained, or its
  // last drain failed: it has observed nothing it can rely on, so the server's claim stands.
  if (sync.bootstrapping || sync.failures > 0) return true;

  // Drained, healthy — so a mirror that is still moving is the import itself, and a mirror that has
  // been still for {@link IMPORT_END_IDLE_MS} is a server handing over nothing. `seedGrowth` leaves
  // `lastRiseAt` at `-Infinity`, so a tab that opens onto a settled mirror and never sees a rise
  // reads as still, which is the case that produced the report.
  return now - growth.lastRiseAt < IMPORT_END_IDLE_MS;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE LADDER
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * The six states: `awaiting` (connected, no cycle completed, empty mirror — says how long, so never a frozen
 * spinner); `importing` (the mirror is growing — an EPISODE, keyed on the client's own count rising, never a stamp);
 * `screenerCandidate` (mail landed, settled, nothing wrong — the Ohbox pane combines it with its own emptiness);
 * `blocked` (our infrastructure declining, mail 0029); `mailboxError` (the mailbox refused us); `noMailbox` (the
 * probe answered: none). `behind` is gone — {@link deviceHoldings} carries the argument; do not put it back without
 * the sidecar's "drained to the horizon and still short" verdict, which is on no wire today. `stopped`/`failing`
 * outrank all six (a frozen mirror count cannot speak); `failing` needs a SUSTAINED streak — a single unconfirmed
 * 401 falls through to the calm states. `quiet` is the rest.
 */
export type MailStateKey =
  | "stopped"
  | "failing"
  | "stale"
  | "catchingUp"
  | "blocked"
  | "mailboxError"
  | "filing"
  | "noMailbox"
  | "importing"
  | "awaiting"
  | "quiet";

export interface MailState {
  key: MailStateKey;
  /**
   * Does this state's copy depend on ELAPSED TIME rather than on a mirror change?
   *
   * If it does, the surface must run its own clock or the sentence freezes: a healthy tab
   * publishes an identical `SyncStatus` every eight seconds and `engine.tsx` deliberately
   * bails out of re-rendering for it, so nothing else would ever re-paint. See
   * `MailStateProvider.tsx`.
   */
  clock: boolean;
  /** Messages in the MIRROR. `importing` renders it; the others carry it for context. */
  count: number;
  /**
   * Messages in the ACCOUNT — the denominator {@link count} is measured against, or `null`
   * whenever no sentence may name one. `null` is the common case: the hosted browser client
   * never learns this number, one silent mailbox withdraws it for the whole account, and it is
   * withheld unless STRICTLY greater than {@link count} — a passed denominator is a stale
   * reading, and the honest response is to stop quoting it, never to clamp. Carried by
   * `importing` alone — progress while the mirror moves; every other state leaves it `null` (a
   * frozen numerator under a fraction is the frozen-counter lie this module refuses elsewhere).
   */
  total: number | null;
  /**
   * `blocked` only, and a COPY TOKEN, not a wire value — `SyncBar`
   * interpolates it into `t(\`blocked_${reason}\`)`. A member of
   * {@link SYNC_BLOCK_REASONS} (mail 0029) or {@link STAND_DOWN_REASONS}
   * (mail 0027), or `null` for an unrecognised sync-block reason — the
   * state still fires with generic copy; silence would re-create mail
   * 0029's "unobservable by design" one layer up. The two sets share one
   * field because they are one sentence to a reader; they stay apart at the
   * source. A stand-down never yields `null` ({@link standDownToken}).
   */
  reason: SyncBlockReason | StandDownReason | null;
  /** `mailboxError` only — the `errorCode` key whose sentence lives in `mailboxes.err_*`. */
  errorCode: string | null;
  /**
   * `stale` only — the instant the mirror on screen was last known current, verbatim from the
   * freshness input (the engine's own completion stamp, or the desktop mirror's). It is the
   * time the label renders — "As of 14:32 · catching up" — and the arm never fires without it:
   * a staleness claim with no time in it is not a sentence anyone can check.
   */
  asOf: string | null;
  /** The mailbox the state is ABOUT, when it is about exactly one. */
  address: string | null;
  /**
   * Whole minutes this state has been true; which clock differs per state
   * because the useful number does: `blocked` — since `syncBlockedSince`,
   * the server's own record; `awaiting` — since the mailbox was connected
   * (`createdAt`), the one per-mailbox clock not shared between rows and
   * the honest answer to "how long have I been looking at this". `null`
   * when the stamp behind it is absent or unparseable.
   */
  minutes: number | null;
  /**
   * `awaiting` only — has this outlasted what a first import is measured to take?
   *
   * Not a different state: the same fact, said without the explanation, plus the one action
   * that exists. It never claims an error, because at this point nothing has failed.
   */
  slow: boolean;
  /**
   * Mail has landed, the mirror is settled, and nothing is wrong — so IF a list is empty, the
   * mail is in the Screener and that is worth saying.
   *
   * A flag and not a key, because it is a statement about the OHBOX. Rendered by the shell
   * strip it would tell somebody standing in the Screener that everything is in the Screener.
   * The rule `SyncBar.tsx` enforces is one DERIVATION, not one DOM node: this is derived here,
   * once, and the pane may only combine it with the row count it is already the authority on.
   * The pane may not re-derive it.
   */
  screenerCandidate: boolean;
  /**
   * `filing` only — how many of OUR OWN filings the mail server has not
   * applied yet. Its own field, not `count`: overloading would make one
   * number mean two things depending on the key beside it, and the first
   * surface to read it without checking the key would report a backlog of
   * six as a mailbox holding six messages. `0` in every other state; the
   * arm never fires at 0 ({@link MailboxFacts.pendingMoves} — "Filing 0
   * messages" is as wrong as silence).
   */
  pending: number;
  /**
   * `filing` only — WHY those filings are outstanding, or `null` when the arm has not fired OR
   * when no live mailbox reported the aggregate.
   *
   * The second half is the load-bearing one: `null` beside `key === "filing"` means the servers
   * behind this account sent the COUNT and not the split, so the surface renders the sentence it
   * always rendered. A renderer that assumed this object whenever the key was `filing` would
   * paint an empty reason over an older deployment.
   */
  filing: FilingReport | null;
  /**
   * May an empty list be stated as a settled fact? Reported: a slow connection showed "Nothing in your
   * Ohbox" before the product finished looking — "empty", "not loaded yet" and "the read failed" had
   * one rendering. A qualification each pane owns, not a strip key (a sentence that flashes for 200 ms
   * is worse than a quiet frame). Reads the ladder's VERDICT, not its conditions: `!bootstrapping ||
   * key === "stopped" || key === "failing"` — keys, so a change to what counts as failing flows
   * through. `bootstrapping` is the right clock here (has anything authoritative populated this mirror
   * yet — seconds, and the scheduler hydrates from the device before it drains); the two key arms stop
   * a failing loop from spinning "still loading" for ever.
   */
  settled: boolean;
}

const QUIET: MailState = {
  key: "quiet",
  clock: false,
  count: 0,
  total: null,
  reason: null,
  errorCode: null,
  asOf: null,
  address: null,
  minutes: null,
  slow: false,
  screenerCandidate: false,
  pending: 0,
  filing: null,
  // Overwritten for every state by `deriveMailState`'s wrapper — see {@link MailState.settled}.
  // `true` here so that a `QUIET` used directly as a resting value never withholds a pane's
  // ordinary empty state.
  settled: true,
};

/**
 * When a first import has taken longer than one is measured to take. Ten minutes, set against a
 * measurement: attach has been timed at ~6 minutes, twice, on a mailbox of a few thousand
 * messages — so six minutes with an empty mirror is NORMAL, and escalating at three would dress
 * a healthy large-mailbox import as a fault. Attaches are serial, so a second mailbox waits
 * behind the first; ten leaves room. It must stay under the server's `syncLag` alert threshold
 * (15 min) — `test/mail-state.test.ts` asserts that against the real constant: if operators are
 * paged before the screen escalates, the user is again the last to know.
 */
export const AWAITING_SLOW_MS = 600_000;

/**
 * Why an outstanding filing is outstanding — the four situations one
 * sentence used to cover ("the server is catching up", on screen ten
 * minutes, twice; the count was right, the reason was not):
 *  · WORKING — the organizer has not reached this mailbox in its rotation.
 *  · WAITING — the server refused the move; deferred until    `next_attempt_at`, so nothing is catching up.
 *  · STUCK — refused more than once, or outstanding past a rotation.
 *  · SOMEBODY ELSE FILES IT — a reader install: the reconcile pass is
 *    skipped, and "the server is catching up" is false by construction.
 */
export type FilingArm = "working" | "waiting" | "stuck" | "elsewhere";

/**
 * The aggregate `GET /mailboxes` reports for one mailbox's outstanding filings.
 *
 * OPTIONAL on {@link MailboxFacts}, and ABSENT is "this build cannot tell" — the same contract
 * {@link MailboxFacts.pendingMoves} states, and the reason the legacy count is still read: an
 * older server sends the number alone, and the arm must then behave exactly as it did before this
 * field existed rather than going silent or inventing a reason.
 */
export interface FilingFacts {
  /** Outstanding filings the next reconcile turn will pick up. */
  due: number;
  /** Outstanding filings that are asleep — refused, retry scheduled ahead. */
  deferred: number;
  /** When the oldest outstanding filing was written, or null when none is. */
  oldestPendingAt: string | null;
  /** When the soonest deferred filing may be attempted again, or null. */
  nextAttemptAt: string | null;
  /** The highest refusal count among the outstanding filings. */
  attempts: number;
  /** Why the worst-off outstanding filing was refused, or null. A CLOSED set on the wire. */
  lastRefusalClass: string | null;
  /** When this was read. The strip states it rather than running a clock over a stale figure. */
  asOf: string;
  /** When the organizer's last pass finished, or null where there is no heartbeat to read. */
  lastCycleAt: string | null;
}

/** What the strip renders once the filing arm has fired. See {@link FilingArm}. */
export interface FilingReport {
  arm: FilingArm;
  /** Outstanding filings across the live mailboxes — `due + deferred`. */
  count: number;
  /** How many of {@link count} are asleep. */
  deferred: number;
  /** The refusal class, narrowed to the closed set this build knows, or null. */
  reason: FilingRefusalReason | null;
  /** When the soonest retry is due, verbatim, or null. */
  nextAttemptAt: string | null;
  /** Whole minutes the oldest outstanding filing has waited, or null. */
  waitedMinutes: number | null;
  /** Whole seconds since the organizer's last pass finished, or null. */
  lastPassSeconds: number | null;
  /** For `elsewhere`: who files this mailbox, and whether they are still renewing the claim. */
  who: { kind: string | null; name: string | null; stopped: boolean } | null;
  /** When the facts behind this were read — the strip says "as of HH:MM". */
  asOf: string | null;
}

/**
 * The refusal classes this build renders a sentence for.
 *
 * The SERVER owns the closed set (`FILING_REFUSAL_CLASSES` in `@trafficflow/db`) and this client
 * re-declares it, exactly as {@link SYNC_BLOCK_REASONS} re-declares its own: the shell may not
 * import the server's packages, and a fifth member during a rolling deploy is a real possibility.
 * An unrecognised value therefore becomes `unknown`, which HAS a sentence ("your server would not
 * say why") — silence there would restore the invisibility this whole arm exists to end.
 */
export const FILING_REFUSAL_REASONS = [
  "refused", "no_such_folder", "read_only", "over_quota", "unknown",
] as const;

export type FilingRefusalReason = (typeof FILING_REFUSAL_REASONS)[number];

function filingReason(v: string | null): FilingRefusalReason | null {
  if (v === null) return null;
  return (FILING_REFUSAL_REASONS as readonly string[]).includes(v)
    ? (v as FilingRefusalReason)
    : "unknown";
}

/**
 * How long one serialized reconcile rotation legitimately takes, as this strip must assume.
 *
 * NOT a configuration read and not a claim about a particular deployment: the worker's tick queues
 * one pass over every mailbox, each gets one bounded turn, and the source's own doorbell figure
 * puts a busy deployment's pass at about four minutes (longer on the first rotation after a
 * restart, where every turn is a cold one). This is the floor the stuck threshold has to clear.
 */
export const FILING_ROTATION_ESTIMATE_MS = 240_000;

/**
 * How long an outstanding filing may wait before the strip calls it STUCK
 * rather than WORKING. Five minutes; it must exceed
 * {@link FILING_ROTATION_ESTIMATE_MS} or a mailbox waiting its ordinary
 * turn is reported stuck — a false alarm on the healthy path, which is how
 * a warning becomes something people learn to ignore. A test asserts the
 * inequality, so the two move together. Data-driven, never a flag: the
 * operand is the row's own `updated_at` — nothing here reads a setting, so
 * there is no state to get out of step with the rows.
 */
export const FILING_STUCK_MS = 300_000;

/**
 * How many refusals make an outstanding filing STUCK regardless of how long it has waited.
 *
 * Two, because the retry ladder's first two rungs are one minute and five: a row that has been
 * refused twice has been refused across a gap the server had every chance to recover in, and the
 * next rung is fifteen minutes. One refusal is WAITING — the common "refusal" is a folder briefly
 * read-only during the provider's own maintenance, and calling that stuck would be alarming about
 * something that is about to fix itself.
 */
export const FILING_STUCK_ATTEMPTS = 2;

/**
 * Which of the four sentences, over every live mailbox that reported the aggregate. One report
 * for the account, and the worst arm wins — severity, not recency: a filing refused four times
 * is the fact worth attention even while another mailbox files normally. The operands are
 * aggregated across the mailboxes the winning arm covers (longest wait, soonest retry, highest
 * attempts), so no number in the sentence is about a different mailbox than the arm chose.
 * Returns `null` when no live mailbox carries the aggregate — an older deployment sends the
 * count alone, and the caller renders the sentence it always rendered.
 */
function filingReportOf(live: MailboxFacts[], now: number): FilingReport | null {
  const rows = live.filter((m): m is MailboxFacts & { filing: FilingFacts } =>
    m.filing !== undefined && m.filing !== null);
  if (rows.length === 0) return null;

  const count = rows.reduce((n, m) => n + m.filing.due + m.filing.deferred, 0);
  const deferred = rows.reduce((n, m) => n + m.filing.deferred, 0);
  const attempts = rows.reduce((n, m) => Math.max(n, m.filing.attempts), 0);
  const oldestPendingAt = earliest(rows.map((m) => m.filing.oldestPendingAt));
  const nextAttemptAt = earliest(rows.map((m) => m.filing.nextAttemptAt));
  // The NEWEST read across the mailboxes: they are polled in one request, so these agree in
  // practice, and where they do not the most recent is the honest "as of".
  const asOf = rows.reduce<string | null>(
    (best, m) => (best === null || m.filing.asOf > best ? m.filing.asOf : best), null,
  );
  const lastCycleAt = rows.reduce<string | null>(
    (best, m) => {
      const at = m.filing.lastCycleAt;
      if (at === null) return best;
      return best === null || at > best ? at : best;
    }, null,
  );
  const reason = filingReason(
    rows.map((m) => m.filing.lastRefusalClass).find((c) => c !== null) ?? null,
  );
  const waitedMinutes = minutesSince(oldestPendingAt, now);
  const lastPassSeconds = secondsSince(lastCycleAt, now);
  /* NOTHING OUTSTANDING ⇒ NO REPORT, rather than a report with an arm nobody renders.
   *
   * The caller only attaches this once the arm has fired, so a `count: 0` report was a value that
   * could be computed and never displayed — a state whose contrary is unreachable from any
   * surface, which the next reader takes for a guarantee. `null` is the same answer the ABSENT
   * case gives and the caller already handles it. */
  if (count === 0) return null;

  const base = {
    count, deferred, reason, nextAttemptAt, waitedMinutes, lastPassSeconds, who: null, asOf,
  } as const;

  /* Who files this mailbox, when it is not us: a READER's decisions are
   * applied by the install that HOLDS the mailbox (`reconcileFolders` is
   * skipped for a reader), so "the server is catching up" is false by
   * construction. Outranks the three arms below because it changes WHO the
   * sentence is about. A holder must be NAMED, not merely "the role says
   * reader": the per-cycle peek rewrites the holder columns all-null on an
   * empty claim folder, so a genuine stand-down decays into the holder-less
   * shape on its own (`readerStandDown` records the same rule) — a
   * holder-less reader falls through to the ordinary arms, which describe
   * our own side and are true there. */
  const elsewhere = rows.find((m) =>
    m.organizerRole === "reader"
    && (m.filing.due + m.filing.deferred) > 0
    && Boolean(m.organizedBy && (m.organizedBy.kind || m.organizedBy.name)));
  if (elsewhere) {
    return {
      ...base,
      arm: "elsewhere",
      // The SCHEDULE is withheld deliberately: it is our ladder, and it is not what these rows
      // are waiting for.
      reason: null, nextAttemptAt: null,
      who: {
        kind: elsewhere.organizedBy?.kind ?? null,
        name: elsewhere.organizedBy?.name?.trim() ? elsewhere.organizedBy.name : null,
        // `stopped` is the holder no longer renewing its claim — a different situation from a
        // holder that is renewing and simply has not run its own pass yet, and the two get
        // different sentences. ABSENT reads as NOT stopped, the safe direction: telling somebody
        // their other machine is off when it is on is the more alarming error.
        stopped: elsewhere.organizerState === "stopped",
      },
    };
  }

  /* STUCK — refused past the ladder's early rungs, OR outstanding longer than a rotation can
   * account for. The second arm is not redundant: a TRANSPORT failure writes NOTHING (no attempt
   * count, no deferral), so a row can sit due-now for ever with `attempts` at 0 while the mail
   * host is unreachable, and keying stuck on refusals alone would leave exactly that case saying
   * "filing" indefinitely. See {@link FILING_STUCK_MS} for why the wait must exceed the rotation
   * estimate. */
  if (attempts >= FILING_STUCK_ATTEMPTS
      || (waitedMinutes !== null && waitedMinutes * 60_000 >= FILING_STUCK_MS)) {
    return { ...base, arm: "stuck" };
  }

  /* WAITING — a refusal is recorded and the retry is scheduled ahead. Keyed on `deferred` rather
   * than on `attempts`, because attempts SURVIVE the deferral expiring: a row refused once whose
   * next attempt has already come round is due again and is being worked on, which is WORKING.
   * The class stays on the report either way — it is what the row has been through, not a
   * schedule. */
  if (deferred > 0) return { ...base, arm: "waiting" };

  /* WORKING — the ordinary shape of the handoff. `lastPassSeconds` is the half that makes it a
   * fact rather than reassurance. */
  return { ...base, arm: "working" };
}

/** Whole seconds since an ISO instant, floored, never negative. */
function secondsSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 1_000));
}

/** Whole minutes since an ISO instant, floored, never negative. */
function minutesSince(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 60_000));
}

/** The oldest of the given ISO stamps — the one that has been true longest. */
function earliest(stamps: Array<string | null>): string | null {
  let best: { iso: string; t: number } | null = null;
  for (const iso of stamps) {
    if (iso === null) continue;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) continue;
    if (best === null || t < best.t) best = { iso, t };
  }
  return best?.iso ?? null;
}

/** Everything the ladder is allowed to read. Every field is something the CLIENT observes. */
export interface MailStateInputs {
  /**
   * `useSyncStatus()` — what the tab's own drain loop is doing. Structural,
   * re-declared rather than imported ({@link MailboxFacts}'s reason: this
   * module ships in the Desktop mirror). All four scheduler fields, but the
   * ladder keys on three: `refused` — a coded 401/403 the server has not
   * yet RE-MADE — is received and NOT rendered as a failure; one request's
   * evidence is treated as transient and falls through to the calm progress
   * states. Only a confirmed refusal (`terminal`) speaks — see
   * {@link climb}'s `failing` arm.
   */
  sync: { bootstrapping: boolean; failures: number; terminal: boolean; refused: boolean };
  /** `SYNC_FAILURE_STREAK`, passed in so the surfaces cannot drift from the scheduler. */
  failureStreak: number;
  /**
   * The freshness contract's verdict (INSTANT-ARCH §6.6) — structural,
   * re-declared for {@link MailboxFacts}'s reason. On the web it is
   * `useFreshness()`; on the desktop it is the SIDECAR mirror's verdict
   * over `GET /mirror/freshness`, because the window engine drains the
   * sidecar's local feed and its own stamp cannot say the desktop is behind
   * the hosted account. `unknown` — never drained; the skeleton owns it.
   * `stale` — truth as of `asOf`, labeled quietly until a drain settles
   * (staleness labeled is honest; silent is the bug). `current` — resting.
   */
  freshness: { state: "unknown" | "stale" | "current"; asOf: string | null };
  /**
   * THE RENDERED ENGINE'S OWN VERDICT — `useFreshness()`, never the probe. Identical to
   * {@link MailStateInputs.freshness} wherever no probe overrides (web, the demo); different on
   * the desktop, where the label reads the SIDECAR's stamp and this reads the window engine's.
   * It exists for exactly one reader: the `settled` wrapper. Settled is a statement about the
   * mirror ON SCREEN — the window engine's own in-memory store, which can be mid-first-snapshot
   * and empty while the sidecar's mirror is complete — so upstream freshness must not settle a
   * pane the rendered store has not populated.
   */
  engineFreshness: { state: "unknown" | "stale" | "current"; asOf: string | null };
  /**
   * `GET /mailboxes`, narrowed — or `null` for "we cannot see mailboxes".
   *
   * **`null` and `[]` ARE DIFFERENT FACTS and the distinction is load-bearing.** `null` is the
   * demo, the Desktop bundle, a probe that has not answered yet, and a probe that FAILED; `[]`
   * is "the server told us there are none". Collapsing a rejected `GET /mailboxes` into `[]`
   * would render "No mailbox connected" to somebody who has five — a 503 turned into a lie
   * about their account.
   */
  mailboxes: MailboxFacts[] | null;
  /** Messages in the MIRROR — every folder, not the Ohbox's rows. */
  mirrored: number;
  /** The growth sampler's memory. THE progress signal. */
  growth: MirrorGrowth;
  /** `Date.now()`, injected so the ladder is pure and the tests need no clock control. */
  now: number;
  /** True in the demo and on the Desktop: a fixture world has no sync to report. */
  demo: boolean;
}

/**
 * What to say, from what the client can see — plus whether the panes may
 * call an empty list empty. Pure. The `settled` stamp is applied HERE and
 * not inside the ladder: it is a property of every state and `climb` has
 * ten returns — stamping in one place makes the flag impossible to omit,
 * including from the eleventh state somebody adds next year. That is also
 * why the derivation can read `climb`'s KEY: the verdict exists before the
 * stamp does ({@link MailState.settled}).
 */
export function deriveMailState(input: MailStateInputs): MailState {
  const state = climb(input);
  return {
    ...state,
    // A COMPLETED DRAIN IS SETTLED EVIDENCE, whatever this tab's own loop is doing — the mobile
    // boot rule (`mirrorSettled`), promoted (INSTANT-ARCH §6.6). `bootstrapping` means "this
    // TAB's first drain has not finished", which on a warm STALE resume is true for the whole
    // catch-up — and without this clause every zero-row pane wore a skeleton over a mirror the
    // freshness stamp proves renderable (a completed drain once emptied it; the strip is
    // meanwhile labeling the age). `unknown` — no stamp, or a probe that has not answered — is
    // exactly the population the skeleton exists for and keeps it.
    settled:
      !input.sync.bootstrapping || state.key === "stopped" || state.key === "failing"
      // The RENDERED engine's stamp, deliberately not the label's (probe-overridden) verdict:
      // on the desktop the sidecar can be current while the window's own mirror is still
      // mid-first-snapshot and empty — upstream freshness settles nothing here.
      || input.engineFreshness.state !== "unknown",
  };
}

/**
 * The ladder itself. First match wins.
 *
 * The order below is PRECEDENCE and is deliberately not the order the states are numbered in.
 * Each step says why it outranks the next.
 */
function climb(input: MailStateInputs): MailState {
  const { sync, failureStreak, freshness, mailboxes, mirrored, growth, now, demo } = input;

  // A fixtures engine drains once from local data and is permanently settled. There is no
  // sync here to have a state, and the demo promises that nothing leaves the tab — so it gets
  // the resting value before anything else is even considered.
  if (demo) return QUIET;

  // ── The loop's own health outranks everything, because it invalidates the evidence ──────
  //
  // `terminal` first: the loop has disarmed itself and will not restart, so no count below
  // can move and no mailbox fact below can be refreshed.
  if (sync.terminal) return { ...QUIET, key: "stopped" };
  // A SUSTAINED failing loop means the mirror is frozen — every state below
  // would read a number that cannot change. The streak is what makes this
  // sustained rather than a blip. `sync.refused` deliberately does NOT join
  // it: a single coded 401/403 the server has not re-made is one request's
  // evidence and routinely transient (cold function, warming session,
  // deploy alias mid-roll — `sync-scheduler.ts`); rendering "failed" on it
  // painted a false alarm over a healthy first sync. An unconfirmed refusal
  // takes the calm `catchingUp` floor below — never "failed", never
  // silence. What surfaces a failure banner is a sustained streak here, or
  // a confirmed refusal latched `terminal` and rendered by `stopped`.
  if (sync.failures >= failureStreak) return { ...QUIET, key: "failing" };

  // STALE — the content on screen is real and OLD, and the strip says
  // which: "As of <time> · catching up", the last completed drain's own
  // stamp; it clears itself when a drain settles. A claim about AGE, not
  // progress (importing owns the moving count). Below `stopped`/`failing`
  // (a frozen loop is not "catching up"); above everything else including
  // the probe gate — staleness is an ENGINE fact known before any probe
  // answers, and the first seconds of a days-stale resume are exactly when
  // the label is owed. Never without a time: the freshness input carries
  // `asOf` for every `stale` by construction; the guard is belt for a
  // probe-fed desktop value.
  if (freshness.state === "stale" && freshness.asOf !== null) {
    return { ...QUIET, key: "stale", clock: true, count: mirrored, asOf: freshness.asOf };
  }

  // The calm FLOOR for an UNCONFIRMED coded refusal: a 401/403 made once
  // and not yet re-made (`REFUSAL_CONFIRM_MS`) must never be answered with
  // "Sync failed. Retrying." — nor with silence. A floor, not a
  // high-priority arm: the visible states below are calm true sentences in
  // their own right, so a refusal during one of them changes nothing a
  // reader needs (`test/mail-state.test.ts` pins the first-sync case);
  // what it replaces is only the silent `quiet` fall-throughs. Once
  // confirmed, the scheduler latches `terminal` and `stopped` renders the
  // banner. Not in the `settled` keys: a transient refusal is not an
  // answer about whether the mailbox is empty.
  const quietOrCatchingUp: MailState = sync.refused ? { ...QUIET, key: "catchingUp" } : QUIET;

  // "We cannot see mailboxes" — not "there are none". Everything from here reads them. Silent unless
  // a refusal is being confirmed, in which case the floor speaks rather than the screen going blank.
  if (mailboxes === null) return quietOrCatchingUp;

  const live = mailboxes.filter((m) => m.status !== "disabled");

  /* 4a. STOOD DOWN — the organizer lease is declining to serve it. The
   * `live` filter drops every `disabled` row, so an account whose only
   * mailbox was stood down read "No mailbox connected" minutes after
   * connecting one. This arm scans `mailboxes`, not `live` — "disabled" has
   * two causes and `disabledReason` discriminates; an ordinary disconnect
   * still reaches `noMailbox`. It outranks `blocked`: a sync block retries
   * and clears itself, a stand-down is terminal from this side — between
   * two true sentences, the one that will not stop being true wins. Above
   * the growth states for `blocked`'s reason. `minutes` stays null: nothing
   * timestamps a stand-down. */
  /* `typeof === "string"` AND NOT `!== null`, and the difference is a caught defect. The field
   * is typed `string | null`, but a probe compiled before the field existed — a cached Cloud
   * bundle, a fixture that predates it — simply omits it, and `undefined !== null` is TRUE. That reading
   * turns EVERY ordinary disconnect into an organizer conflict, which is a brand-new false
   * sentence in the place a false sentence was being removed. It went red on exactly that. */
  /* A stood-down row whose ADDRESS is back is superseded, not speaking.
   * Reconnecting after a stand-down is the supported path
   * (`mailboxes_active_address_uq` is unique only WHERE status <> 'disabled'), and it leaves the old row disabled with
   * `organized_elsewhere:*` for ever — which pinned the whole strip to
   * "Not organized here" while Settings showed the same address connected
   * and syncing (measured on a self-hosted instance). The comparison is
   * `addressKey` — the fold the Mailboxes pane already uses — imported, not
   * re-derived: a case-sensitive rail beside a case-folding pane put the
   * contradiction back from the other side, and trimming is wider than the constraint (`address-key.ts`).
   */
  const liveAddresses = new Set(live.map((m) => addressKey(m.address)));
  const stoodDown = mailboxes.find(
    (m) => m.status === "disabled"
      && typeof m.disabledReason === "string"
      && !liveAddresses.has(addressKey(m.address)),
  );

  if (stoodDown) {
    return {
      ...QUIET,
      key: "blocked",
      count: mirrored,
      reason: standDownToken(stoodDown.disabledReason),
      address: stoodDown.address,
    };
  }

  // 4. BLOCKED — our own infrastructure declining to serve it (mail 0029).
  // Above the error and progress states: the mailbox is `connected` with no
  // `errorCode` (the design of the column), so nothing else on the ladder
  // would notice; and a mailbox not being synced makes "syncing" false whatever a second mailbox is doing. The test is
  // `syncBlockedSince !== null`, NOT the reason field: the server narrows
  // the reason to the closed set and forwards the timestamp
  // unconditionally, so a fourth reason arrives as `{reason: null, since:
  // <ts>}` — gating on the reason gave that mailbox silence. Complete only
  // because reason non-null ⇒ since non-null (five writers audited, each
  // sets and clears both in one statement).
  const blocked = live.find((m) => m.syncBlockedSince !== null);
  if (blocked) {
    return {
      ...QUIET,
      key: "blocked",
      clock: true,
      count: mirrored,
      reason: isSyncBlockReason(blocked.syncBlockedReason) ? blocked.syncBlockedReason : null,
      address: blocked.address,
      minutes: minutesSince(blocked.syncBlockedSince, now),
    };
  }

  // ── 5. MAILBOX ERROR — the mailbox itself refused us ───────────────────────────────────
  //
  // Above the progress states because a mailbox in `error` is quarantined and earning a
  // backoff: whatever the mirror is doing, THIS mailbox is contributing nothing to it.
  const failed = live.find((m) => m.status === "error");
  if (failed) {
    return {
      ...QUIET,
      key: "mailboxError",
      count: mirrored,
      errorCode: failed.errorCode ?? "unknown",
      address: failed.address,
    };
  }

  // 5a. FILING — we have filed the mail and the server has not. The API
  // never opens IMAP: decisions write `folder_state` and the worker moves
  // mail on its next cycle — a window nothing above this arm can see
  // (still `connected`, not `blocked`, not stood down), so the ladder fell
  // through to `quiet` while the backlog grew. Below `mailboxError` (a
  // quarantined mailbox is the larger fact); above `importing` (decisions
  // going OUT must not be buried under mail coming in).
  // `typeof === "number"` and `> 0`: an absent field must produce silence,
  // and "Filing 0 messages" is a sentence about nothing. Summed across live
  // mailboxes; the address is named only when there is exactly one.
  const filing = live.filter((m) => typeof m.pendingMoves === "number" && m.pendingMoves > 0);
  const outstanding = filing.reduce((n, m) => n + (m.pendingMoves ?? 0), 0);
  // And WHY they are outstanding, when the server can say (mail 0097): the
  // count fires the arm; this decides which of four sentences it renders
  // ({@link FilingArm}). The report is derived over the mailboxes that
  // CARRY the aggregate — possibly a subset of `live` during a rolling
  // deploy. `filingReportOf` returns null when none does and when nothing
  // is outstanding, so a non-null report is by itself the arm's condition;
  // the legacy count remains the only other way in, and an older server
  // renders exactly what it rendered before.
  const report = filingReportOf(live, now);
  if (outstanding > 0 || report !== null) {
    return {
      ...QUIET,
      key: "filing",
      // The mirror is not the subject here, but every state carries it for context.
      count: mirrored,
      // The LEGACY count where it exists, and the report's own total where the aggregate is the
      // only thing on the wire. They are the same number on a current server (`due + deferred`
      // IS `pendingMoves`); they differ only for a mailbox whose row predates one of the two,
      // and taking the larger would double-count nothing while taking `outstanding` alone would
      // report zero for a client whose server sends the split and not the count.
      pending: Math.max(outstanding, report?.count ?? 0),
      address: filing.length === 1 ? filing[0]!.address : null,
      filing: report,
      // TIME-DEPENDENT, so the strip runs its own clock: nothing in the MIRROR changes when the
      // worker drains this backlog — `folder_state` is server-side and `/sync` carries no
      // change for a move that has already been applied locally — so a state keyed only on
      // mirror movement would never re-paint and the number would freeze at whatever it was.
      //
      // The clock is why {@link FilingFacts.asOf} exists. The facts behind it are re-fetched
      // every 30 s and on nothing else, so a clock alone was animating a number up to thirty
      // seconds stale; the surface states when it last looked instead of implying it is live.
      clock: true,
    };
  }

  // ── 6. NO MAILBOX — the probe answered, and there are none ─────────────────────────────
  //
  // Reachable only because `mailboxes` is known to be non-null. Nothing can arrive, and no
  // amount of waiting changes that, so the two progress states below would both be false.
  if (live.length === 0) return { ...QUIET, key: "noMailbox" };

  const connected = live.filter((m) => m.status === "connected");
  if (connected.length === 0) return quietOrCatchingUp;

  // 2. IMPORTING — the mirror is growing. Above `awaiting` by construction
  // (that arm needs an empty mirror) and above the Screener pointer ("it is
  // all in the Screener" is a claim about a set still changing). `now` is
  // the shell's clock, beaten by `MailStateProvider` while `state.clock` is
  // true — the reducer only runs when the mirror moves, so a stopped import
  // would otherwise never be told it had. The denominator is
  // {@link deviceHoldings} — the same derivation the Mailboxes pane reads,
  // so strip and pane cannot answer "how much is on this device"
  // differently; `null` means no sentence may name a total.
  const totalIfAhead = deviceHoldings(mailboxes, mirrored)?.total ?? null;

  if (isImporting(growth, sync.bootstrapping, now)) {
    return { ...QUIET, key: "importing", clock: true, count: mirrored, total: totalIfAhead };
  }

  /**
   * Has any cycle completed? The ONE use of `lastSyncAt`, and only as a negative — sound under
   * both worker defects (see the header): only ids in `synced` are stamped, so a null cannot be
   * somebody else's success or an early stamp. Also necessary: a non-null stamp over an empty
   * mirror means a cycle ran and the mailbox is genuinely empty — which must be QUIET, not
   * "waiting" for ever. `every`, not `some`: with one synced and one young mailbox the strip
   * stays quiet about the young one — its status belongs on its row; `some` would put "nothing
   * has arrived" over a mirror already full from the other mailbox.
   */
  const noCycleYet = connected.every((m) => m.lastSyncAt === null);

  // ── 1. AWAITING — connected, and nothing at all has arrived ────────────────────────────
  //
  // The state the dead string was shown for, and it is often CORRECT. What was wrong was
  // saying it alone, for ever, and saying it while the mirror grew. It carries the elapsed
  // minutes so it cannot be mistaken for a frozen spinner, and escalates past
  // `AWAITING_SLOW_MS` — to a plainer sentence, never to a claim that something failed.
  if (noCycleYet && mirrored === 0) {
    const since = earliest(connected.map((m) => m.createdAt));
    return {
      ...QUIET,
      key: "awaiting",
      clock: true,
      address: connected.length === 1 ? connected[0]!.address : null,
      minutes: minutesSince(since, now),
      slow: since !== null && now - new Date(since).getTime() >= AWAITING_SLOW_MS,
    };
  }

  // 2b. THE IMPORT FLOOR — the server has not stamped this mailbox's first
  // import done. A first import leaves a PARTIAL mailbox for minutes, and
  // the growth arm is blind at the edges: a tab opening onto it declares a
  // mailbox with a hole complete. `initial_import_completed_at` is read as
  // a floor, `=== null` never `== null` (an older server omits the field,
  // degrading to growth-only). `some`, not `every`, judged per mailbox — a
  // young mailbox keeps its floor while a four-day sibling releases. The
  // floor is bounded ({@link importFloorSpeaks}); `mirrored > 0` confines
  // it to the partial-mailbox case (`awaiting` owns the empty one);
  // `clock: true` is load-bearing — the release is driven by time alone.
  if (mirrored > 0 && connected.some((m) => importFloorSpeaks(m, growth, sync, now))) {
    return { ...QUIET, key: "importing", clock: true, count: mirrored, total: totalIfAhead };
  }

  // ── 3. THE SCREENER POINTER — a candidate, for the OHBOX to finish ─────────────────────
  //
  // Mail has landed, the mirror is settled and nothing above matched. `mirrored > 0` is
  // load-bearing rather than defensive: without it an account that has never received
  // anything would offer to explain where its mail went.
  //
  // THE SETTLED-CASE FLOOR. This is where the silence hole was: a mirror that had already drained
  // left an unconfirmed refusal with no calm progress arm to fall into, so it fell here to `quiet`
  // — silence. When a refusal is being confirmed the floor speaks instead, and `screenerCandidate`
  // stays false (a refusal is not the "all clear, it's in the Screener" moment).
  if (sync.refused) return { ...QUIET, key: "catchingUp", count: mirrored };
  return { ...QUIET, count: mirrored, screenerCandidate: mirrored > 0 };
}

/**
 * The states the SHELL STRIP renders, in every view.
 *
 * `screenerCandidate` is not among them and never can be — it is not a key. The strip renders
 * account-wide truths; the one view-level truth is finished by the view that owns the fact.
 * Neither surface may re-derive anything.
 */
export function stripSpeaks(key: MailStateKey): boolean {
  return key !== "quiet";
}
