import {
  CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_PROFILE, CAPABILITY_RULES, deriveRequestKey,
  DEFAULT_STALE_AFTER_MS, LeaseUnavailableError, META_FOLDER,
  ClaimReleaseError,
  isMalformed, parseClaim, runLeaseGate,
  type LeaseIo, type LeaseOp, type LeaseSelf, type LeaseVerdict, type OrganizerClaim,
  type RawClaimMessage,
  type TakeoverAuthorization,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { ImapAuth } from "@trafficflow/core/adapters/imap-types";
import type { MailboxDisabledReason } from "@trafficflow/db";

/**
 * THE WORKER'S HALF OF THE ORGANIZER LEASE — composition, and nothing else.
 *
 * `packages/core/src/adapters/organizer-lease.ts` is the engine: the claim format, the decision
 * table, the IO. It shipped with a two-worlds GreenMail test beside it and **zero callers**,
 * which is this repository's own named failure pattern — built, tested, unreachable. A deployed
 * worker organized mailboxes with no claim in `ohmail/_meta` at all, because nothing on this
 * side ever asked. This module is the file that ends that, and it deliberately adds no policy the engine
 * does not already have: it resolves who we are, hands the engine its IO, and translates the
 * verdict into the two things the worker can do about it.
 *
 * The engine is NOT edited to make this wiring easier. Every awkwardness below — the structural
 * `leaseIo` probe, the per-mailbox nonce — is awkward here rather than there on purpose.
 */

/**
 * WHO CLOUD IS, AS AN ORGANIZER — and the single most dangerous constant in this file.
 *
 * The install id is what `decideLease` matches on to answer "is that claim MINE?". Get it wrong
 * in the unstable direction and every worker restart looks like a NEW organizer arriving: the
 * incoming process reads the outgoing one's fresh `cloud` claim as FOREIGN, falls through to the
 * `available` arm, and DISABLES the mailbox. A leader failover would take a customer's mail
 * offline permanently, and it would do it on the deploy that introduced the safety mechanism.
 *
 * So it is a literal, and it is stable by construction:
 *
 *  · **Never derived from `instanceId`.** That is per-process (`instanceIdFrom()`), which is the
 *    failure above exactly.
 *  · **Never derived from the database.** A cutover to a completely fresh database can happen at
 *    any time; an id keyed on the database identity would change the moment one lands, and every
 *    live mailbox would go `available` → `disabled` on the first cycle after the migration.
 *    The mailbox is the master, so the organizer's identity has to be a property of the
 *    ORGANIZER, not of whichever store it happens to be keeping notes in.
 *  · **Scoped by environment**, so staging pointed at a production mailbox is a DIFFERENT
 *    organizer. Two deployments sharing one id do not coexist gracefully: the second to write
 *    expunges the first's claim (the renew's cleanup matches on install id) and the first then
 *    reads a claim it cannot account for and stands ITSELF down. With distinct ids the incumbent
 *    simply keeps its fresh claim and the newcomer sees a live foreign `cloud` claim and stands
 *    down, which is the correct outcome and the quiet one.
 *
 * `TF_ORGANIZER_INSTALL_ID` overrides it, for the one case the default cannot serve: a
 * self-hosted Cloud organizing the same mailbox as ours.
 */
/* ONE DEFINITION, in `@trafficflow/core`. It moved there because the API tier decides the same
   question — "is the claim on this mailbox ours" — and answering it with the KIND rather than the
   id is what let a release clear a row over another Cloud deployment's claim. Re-exported here so
   every existing importer of this module is unchanged.

   NAMED AT ITS LEAF (`/organizer-install`) RATHER THAN AT THE PACKAGE ROOT, and that is not a
   style choice: this module is bundled into the desktop engine, and a VALUE re-export is a runtime
   edge the bundler must keep. Spelled `from "@trafficflow/core"` it pulled that package's index,
   whose `export *` lines convey the whole AI runtime — classification, the model client, drafting
   and the three workflow modules — and from the one that runs a workflow's steps onward the hosted
   database half and the PostgreSQL server driver with it: 37 extra modules in a public download,
   and the engine build refuses over exactly that. The leaf named here imports nothing at all,
   which is what makes it safe to reach from a module the engine carries. */
export { CLOUD_INSTALL_ID_PREFIX, cloudInstallId, organizerEnvironment, resolveCloudInstallId } from "@trafficflow/core/organizer-install";

/**
 * How the claim names us to a human who opens `ohmail/_meta` in another mail client.
 *
 * §4's takeover prompt reads `ohmail on <machine> organizes this mailbox`, so the string has to
 * be a place and not an id. For Cloud the place is Cloud.
 */
export const CLOUD_DISPLAY_NAME = "ohmail Cloud";

/**
 * WHAT AN ORGANIZER RUNNING THIS CODE OFFERS A READER — written onto every claim this composition
 * renews, and the only place either door decides it.
 *
 * ── ONE CONSTANT, BECAUSE BOTH DOORS RUN THIS FUNCTION ────────────────────────────────────
 *
 * The hosted worker and the desktop engine both reach the lease through {@link readMailboxLease},
 * so the advertised set is a property of THIS module rather than of either caller. Two spellings —
 * one per door — would be a capability a reader detects on Cloud and not on a desktop, and the
 * reader's answer to "will this holder take my decision" would then depend on which build happened
 * to be organizing rather than on what that build can do.
 *
 * It is deliberately not injectable. A caller that could narrow it PER-CALL could quietly
 * advertise less than the build actually supports — invisibly, and inconsistently across
 * mailboxes on the SAME install. That failure mode is what "not injectable" guards against.
 *
 * ── WHAT THE BUILD SUPPORTS, WHICH IS NOT THE SAME AS WHAT AN ACCOUNT CAN USE (0090) ────────
 *
 * This constant answers "can this code drain a request record". Since mail 0090 there is a second,
 * genuinely per-MAILBOX question — "is there a shared secret to sign one with" — and the two are
 * different facts that must not be collapsed into one constant. A build with the drain but a
 * mailbox with no key cannot verify anything, so advertising `requests` would invite readers to
 * queue decisions this organizer will refuse `unauthenticated` for ever.
 *
 * {@link organizerCapabilitiesFor} is where the two meet, and it is the ONLY way this set reaches
 * a claim. The per-call input it takes is a FACT about the mailbox (derived from the credential),
 * not a preference a caller may express — which keeps the guarantee the paragraph above is about
 * while letting the honest degraded mode exist.
 */
export const ORGANIZER_CAPABILITIES: readonly string[] = [
  CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_PROFILE, CAPABILITY_RULES,
];

/* ── WHY `moves` JOINS THE SET HERE AND NOT EARLIER (mail 0094) ─────────────────────────────
 *
 * A capability means "this build has an applier for that kind of request". `message.move` got its
 * applier and its place in the drain's dispatch table first; the advertisement lands after, and
 * that ORDER is the whole content of the promise. Advertised first, a reader reads `capable: true`
 * off the row, writes a record this organizer has no code to drain, and the person watches a
 * message sit pending until it expires — with nothing to report, because the claim was true about
 * a build that did not exist yet.
 *
 * `profile` joined the same way one slice later, and `rules` the slice after that — each in the
 * same commit as its own applier, never before. The set is COMPLETE for the kinds mail 0094
 * admits: every member of `REQUEST_KINDS` now has an entry in the drain's dispatch table, so the
 * standing path is reached only by a kind from a FUTURE build rather than by one this build is
 * merely behind on. `request-drain.test.ts` keeps a case for that, using a kind no build has.
 *
 * The three `rule.*` kinds share ONE capability because they share one applier and one table: a
 * build that can create a rule can delete one, and advertising them apart would invite a reader
 * to reason about a split that does not exist.
 *
 * The set is still not injectable and still passes through {@link organizerCapabilitiesFor}, so a
 * mailbox with no derived key advertises NOTHING — including `moves`. That is correct rather than
 * incidental: a move request is signed with the same key, so an organizer that cannot verify one
 * cannot apply one either, and inviting the request would be inviting a refusal.
 */

/**
 * WHAT THIS ORGANIZER ADVERTISES FOR THIS ACCOUNT — no key means no capability, and this is the
 * one place that rule is applied.
 *
 * An organizer with no derived key — an OAuth mailbox, where each install holds its own token and
 * there is no shared secret — advertises NOTHING. A reader then reads
 * `organizer_outdated` off the row and refuses the press honestly at its own door, which is the
 * correct and complete degraded mode: no request is queued, no record is written, and nothing
 * waits for a drain that could never verify it.
 *
 * **The capability header is advisory and is never the gate.** It is copied from a claim, and a
 * claim is a message anyone with APPEND rights on the mailbox can write — so an attacker can make
 * a reader BELIEVE an organizer is capable. What that buys them is nothing: the reader appends a
 * record signed with a key it holds, and the organizer either holds the same key (in which case
 * the channel is genuinely available) or refuses it. The header speeds up the honest case; the
 * SIGNATURE is what makes the dishonest one harmless.
 */
export function organizerCapabilitiesFor(o: { hasRequestKey: boolean }): readonly string[] {
  return o.hasRequestKey ? ORGANIZER_CAPABILITIES : [];
}

/**
 * DOES THIS MAILBOX HAVE A REQUEST KEY — the one question `organizerCapabilitiesFor` needs.
 *
 * A thin name over {@link deriveRequestKey}, kept because four hosted processes renew the SAME
 * claim (`cloudInstallId` is deliberately shared, so a per-process id cannot stand the worker
 * down) and must therefore advertise the SAME set. A backstop that renewed the claim without
 * `requests` while the worker renewed it with would make the capability appear and disappear under
 * readers depending on which process last ran.
 *
 * There is nothing to mint and nothing to fail: the key is HKDF over the mailbox password, so this
 * is a pure function of a credential the caller already decrypted to open IMAP at all. An OAuth
 * mailbox answers `false`, which is the honest degraded mode — no shared secret exists, so no
 * organizer can verify a record and none should invite one.
 */
export function mailboxHasRequestKey(o: { auth: ImapAuth; address: string }): boolean {
  return deriveRequestKey(o) !== null;
}

/**
 * An adapter that can hand out the lease's IO.
 *
 * `MailboxAdapter` (`imap-types.ts`) has none of APPEND, FETCH-headers, STORE `\Deleted` +
 * EXPUNGE, CREATE or UNSUBSCRIBE, and they do not belong on it: they are one feature's needs,
 * not every caller's. `ImapAdapter.leaseIo()` is the additive method that hands them over bound
 * to the LIVE login, and this is that shape, probed structurally so the worker does not have to
 * widen an interface every other call site would then see.
 */
export interface LeaseCapableAdapter {
  leaseIo(identity: { installId: string; mailboxId: string }): LeaseIo;
}

/** Does this adapter expose the lease's IO? */
export function hasLeaseIo(adapter: MailboxAdapter): adapter is MailboxAdapter & LeaseCapableAdapter {
  return typeof (adapter as Partial<LeaseCapableAdapter>).leaseIo === "function";
}

/**
 * An adapter that can hand out the lease's READ-ONLY IO.
 *
 * Separate from {@link LeaseCapableAdapter} because the two differ in exactly the way that matters
 * to a reader: `leaseIo()` CREATEs `ohmail/_meta` (an organizer about to write a claim needs
 * somewhere to put it) and `leasePeekIo()` never does, reporting an absent folder as zero claims.
 * A caller that only wants to look must not be able to reach the writing one by accident.
 */
export interface LeasePeekCapableAdapter {
  leasePeekIo(): { listClaims(): Promise<{ ref: unknown; raw: string }[]> };
}

/**
 * IS SOMEBODY ELSE STILL RENEWING, OR DID THEY STOP?
 *
 * `held` — a live foreign claim (the engine's `stand_down`).
 * `stopped` — somebody WAS organizing and nothing has renewed since (the engine's `available`).
 *
 * The engine has three verdicts and this composition used to collapse two of them into one
 * `organize: false` carrying the same `organized_elsewhere:*` reason, which made "Cloud is
 * organizing this mailbox" and "Cloud stopped organizing this mailbox" the same value by the time
 * anything downstream saw it — and those two want opposite actions offered to the user.
 *
 * ── IT IS PERSISTED SINCE MAIL 0083, AND THIS BLOCK USED TO ARGUE THAT IT MUST NOT BE ──────
 *
 * The argument that stood here was: a mailbox that has been stood down is `status='disabled'`,
 * `loadEnabledMailboxes` filters those out, so nothing re-reads its lease until a human asks —
 * and a `held` written to a column would be frozen at the instant of the stand-down, still saying
 * "somebody is organizing this" long after they stopped. The conclusion followed from a premise
 * that is now false. **A loser is a READER: connected, on the roster, cycling.** So there IS a
 * later writer — every reader cycle refreshes `mailboxes.organizer_state` (and the three holder
 * columns beside it) from a `readLeasePeek`, the APPEND-less read, so the stored value is never
 * older than one poll interval.
 *
 * It is amended here rather than deleted because the RULE it derived from still governs and is
 * the thing worth keeping: a column may hold a fact that goes stale only if something is
 * committed to refreshing it. What changed is that something now is. The mailbox with no writer
 * for these columns is a tombstone, which nothing displays.
 *
 * The value is still carried, logged and returned as well — the ROW is what every banner reads,
 * and `readLeasePeek` remains the live answer for the one surface that must not be a poll behind
 * (the web connect step's "already organized elsewhere?" peek).
 */
export type LeaseOccupancyState = "held" | "stopped";

/**
 * The verdict, reduced to what the worker acts on.
 *
 * `organize: false` carries a reason, always — the worker's stand-down write has nowhere to put
 * "I do not know", and `organized_elsewhere:unknown` is the honest name for that case anyway.
 */
export type MailboxLeaseOutcome =
  | { organize: true; nonce: string | null; by: null; uidValidity: number | bigint | null }
  | {
    organize: false;
    reason: MailboxDisabledReason;
    state: LeaseOccupancyState;
    by: OrganizerClaim | null;
  };

export interface MailboxLeaseInput {
  adapter: MailboxAdapter;
  self: LeaseSelf;
  /**
   * WHICH MAILBOX. Required, because what this install remembers about a mailbox's meta folder is
   * keyed by (install, mailbox) — a position remembered under anything coarser answers another
   * mailbox's question, and those positions decide how far down a claim search looks.
   */
  mailboxId: string;
  now: Date;
  /**
   * DOES THIS ACCOUNT HOLD A REQUEST KEY (mail 0090)? Decides whether the claim this call renews
   * advertises `requests` — see {@link organizerCapabilitiesFor}.
   *
   * REQUIRED, with no default, because absent config must not select a branch on its own. An
   * optional field defaulting to `true` would make every
   * caller that forgot it advertise a capability the account may not have; defaulting to `false`
   * would silently disable the channel for callers that simply had not been updated. Neither
   * failure announces itself, so the type demands an answer and every call site has to have one.
   */
  hasRequestKey: boolean;
  /** The press, with its instant, or `null` when nobody asked for this install. */
  takeover?: TakeoverAuthorization | null;
  staleAfterMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * READ THE LEASE, AND SAY WHETHER THIS PROCESS MAY ORGANIZE THIS MAILBOX.
 *
 * ── AN ADAPTER WITH NO `leaseIo` IS A LEASE WE CANNOT READ ────────────────────────────────
 *
 * It throws {@link LeaseUnavailableError} rather than defaulting to "organize". That default is
 * the whole bug this lease exists to close: a gate whose absent dependency selects the permissive
 * branch is a gate that stops existing the first time somebody composes the worker slightly
 * differently, and nothing anywhere says so. Production always gets an `ImapAdapter`, and the
 * suite's fake fleet grows a real in-memory `leaseIo` for the same reason — so the gate is
 * EXERCISED by every worker test rather than skipped by all of them.
 *
 * The cost is bounded and deliberate: `LeaseUnavailableError` is exempted BY CLASS at both call
 * sites, so a mailbox whose lease cannot be read does not sync and is NOT quarantined for it.
 */
export async function readMailboxLease(input: MailboxLeaseInput): Promise<MailboxLeaseOutcome> {
  const { adapter, self, now } = input;
  if (!hasLeaseIo(adapter)) {
    throw new LeaseUnavailableError(
      `this mailbox's adapter cannot reach ${META_FOLDER}, so the organizer lease cannot be ` +
      `read and the mailbox cannot be organized safely`,
      // No IMAP operation was attempted at all, and saying so is the point: this is a COMPOSITION
      // fault (somebody built the worker with an adapter that has no `leaseIo`), not a provider
      // fault, and an operator who sees `op: "list_claims"` would go looking at the mail server.
      { op: "no_lease_io" },
    );
  }

  const result = await runLeaseGate({
    io: adapter.leaseIo({ installId: self.installId, mailboxId: input.mailboxId }),
    self,
    now,
    capabilities: organizerCapabilitiesFor({ hasRequestKey: input.hasRequestKey }),
    ...(input.takeover !== undefined ? { takeover: input.takeover } : {}),
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    ...(input.log !== undefined ? { log: input.log } : {}),
  });

  if (result.verdict.verdict === "organize") {
    return { organize: true, nonce: result.nonce, by: null, uidValidity: result.uidValidity };
  }
  return {
    organize: false,
    reason: standDownReason(result.verdict),
    // Derived from the verdict and from nothing else. `stand_down` is only ever constructed from a
    // parsed FRESH foreign claim and `available` only from a stale or malformed one, so this
    // mapping cannot drift from the engine's own freshness judgement — there is no second clock
    // here and no second staleness window.
    state: result.verdict.verdict === "stand_down" ? "held" : "stopped",
    by: byOf(result.verdict),
  };
}

/**
 * The engine's verdict, as the closed set `mailboxes.disabled_reason` holds.
 *
 * ── THE TWO UNIONS MEET HERE, AND THE COMPILER IS THE PROOF ────────────────────────────────
 *
 * `StandDownReason` (`packages/core`) and `MailboxDisabledReason` (`@trafficflow/db`) are the
 * same three strings written twice, and they have to be: the engine tier may not import the
 * private half, so a single definition is not available. The argument for collapsing a taxonomy
 * into one definition still holds wherever it CAN be one — this is the case where it cannot, so
 * the reconciliation is a typed assignment at the one place the two meet (a member on either side
 * that the other lacks fails `tsc`), plus a test that asserts set equality at runtime, so a
 * widening on the DB side that TypeScript would accept still stops the suite.
 *
 * `available` is a stand-down for the worker even though the engine calls it a third verdict:
 * BECOMING an organizer always requires an explicit human action, and
 * `available` means precisely that nobody is organizing and nobody has authorized us to start.
 * The reason names whoever held it — a Cloud that stopped, a laptop that slept — because that is
 * what the row has to say for the UI to offer the right sentence.
 */
function standDownReason(verdict: Exclude<LeaseVerdict, { verdict: "organize" }>): MailboxDisabledReason {
  if (verdict.verdict === "stand_down") {
    const reason: MailboxDisabledReason = verdict.reason;
    return reason;
  }
  const kind = verdict.by?.kind;
  return kind === "cloud" ? "organized_elsewhere:cloud"
    : kind === "local" ? "organized_elsewhere:local"
      : "organized_elsewhere:unknown";
}

function byOf(verdict: Exclude<LeaseVerdict, { verdict: "organize" }>): OrganizerClaim | null {
  return verdict.by;
}

/**
 * DELETE this organizer's own claims from a mailbox it is ceasing to organize.
 *
 * Returns how many were removed. NOT a stand-down: nobody won this mailbox from us, we stopped
 * being entitled to it (the account lapsed, the user disconnected it, the cap evicted it), and
 * the claim has to go so that the user's own machine can take the mailbox over without waiting
 * out a staleness window it cannot see the end of.
 *
 * `parseClaim` rather than a header grep, so "is this ours" is answered by the same code that
 * answers it inside the gate — a second parser here is how the two come to disagree about a
 * folded header. An adapter with no `leaseIo` releases nothing and says so with a 0 rather than
 * throwing: this runs on a teardown path, and a teardown must not be abortable by bookkeeping.
 */
export async function releaseMailboxClaim(
  adapter: MailboxAdapter, installId: string, mailboxId: string,
  /**
   * THE NONCE OF THE CLAIM THIS INSTALL HOLDS — the second half of the address, and required.
   *
   * `null` means this install cannot name its own claim (its store was wiped, or it has not
   * gated since launch). It is NOT a licence to delete by id: see the refusal below.
   */
  nonce: string | null,
  /**
   * THE STALENESS WINDOW the second term is measured against, and the clock to measure it at.
   * Absent ⇒ {@link DEFAULT_STALE_AFTER_MS}: one staleness clock on every tier, which is the rule
   * every other reader of this folder already holds to.
   */
  opts: { staleAfterMs?: number; now?: Date } = {},
): Promise<number> {
  if (!hasLeaseIo(adapter)) return 0;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = opts.now ?? new Date();
  const io = adapter.leaseIo({ installId, mailboxId });
  /* ── A FULL FOLDER MUST NOT STOP A RELEASE, AND THE ELECTION'S RULE IS NOT THIS ONE ─────────
   *
   * `listClaims()` refuses a folder it could not read whole, because the GATE reads an incomplete
   * election as "nobody holds this mailbox" and would start organizing one somebody else has. That
   * refusal is right there and wrong here, for the reason this function's own contract already
   * gives above: a teardown must not be abortable by bookkeeping.
   *
   * The question here is not "who holds this mailbox" — it is "which of these are MINE", and that
   * is answered per-record by install id. A record this window did not cover cannot be identified,
   * but it also cannot be ours in the case that matters: a claim we are releasing was renewed by
   * APPENDING, so it is at the END of the folder and inside a newest-first window by construction.
   * The error carries those records for exactly this, which is why they are required on it.
   *
   * Getting this wrong is not a lost claim, it is a DELAYED handover: our claim stays in the folder
   * and the next install waits out the staleness window before it may take the mailbox — on the
   * lapse, stop-organizing and remove-mailbox paths, which are precisely the moments a person has
   * just said they want this install to let go. */
  /* ── LOCATE FROM A CURRENT READ, DELETE THE PAIRS THAT READ NAMED, CONFIRM BY RE-READ ────
   *
   * `findOwnRecords` was a server-side header search, and a real provider refused it on EVERY
   * poll (RC3, 38 failed passes in one session, surviving a restart) while a plain current-folder
   * delete of the same record succeeded each time — so the search's reach was paid for with a
   * release that could be refused for ever. It is now a COMPLETE, CURRENT read of the folder
   * under its current UIDVALIDITY (`makeLeaseIo` says how and what that trades away), the
   * selection below is made by the same parser the gate decides with, and the refs handed to the
   * delete are facts from that same read — `removeClaims` refuses refs from another numbering.
   *
   * A read that could not be complete does not become a shorter answer: the io throws
   * {@link ClaimReleaseError} with a code (`over_ceiling`, `unreadable`), and a double's `null`
   * converts to the same class here, because this function RETURNS A COUNT and every caller reads
   * a count as the release having happened. Every caller already logs the failure as
   * `organizer_claim_release_failed`, whose copy says the true consequence — the claim ages out
   * of the folder on its own — and the caller's lapse bound is what keeps that from meaning
   * "for ever".
   *
   * ── AND THE DELETE IS NOT THE PROOF — THE RE-READ IS ─────────────────────────────────────
   *
   * `removeClaims` proves the uids it was handed are gone. What it cannot see is a record of ours
   * the locate never named — measured live as the uid-REWRITE shape: the same claim reappearing
   * at a new uid under a constant UIDVALIDITY, so every delete succeeded and the claim stood. The
   * confirm re-reads the folder and requires NONE of ours to remain; survivors are
   * `still_present`, which no caller may read as released, and the next pass locates afresh from
   * whatever the folder holds then. */
  const locate = async (): Promise<RawClaimMessage[]> => {
    const found = typeof io.findOwnRecords === "function"
      ? await io.findOwnRecords(installId)
      : null;
    if (found === null) {
      throw new ClaimReleaseError(
        "search_refused",
        `the records this install owns in ${META_FOLDER} could not be enumerated — this connection `
        + "cannot ask for them, or the server refused — so a complete release cannot be told "
        + "from a partial one, and nothing was removed on this pass",
      );
    }
    return found;
  };
  /* `parseClaim` rather than a header grep — one parser, the gate's own, so a folded header
   * cannot be ours to one layer and a stranger's to another. A profile document never parses as
   * a claim, which is what keeps the mailbox's settings out of the expunge below. */
  const ownClaimsIn = (messages: RawClaimMessage[]): OrganizerClaim[] => messages
    .map((m) => parseClaim(m.raw, m.ref))
    .filter((c): c is OrganizerClaim =>
      c !== null && !isMalformed(c) && c.installId === installId);
  /**
   * OLD ENOUGH THAT NOTHING IS RENEWING IT. `<=` at the boundary, and no forward clamp: a
   * heartbeat in the future is not stale, which is the safe direction — a claim we cannot age out
   * is one we leave alone.
   */
  const stale = (c: OrganizerClaim): boolean =>
    c.heartbeat.getTime() <= now.getTime() - staleAfterMs;
  /** OUR CLAIM, or a STRANDED record of ours — the two terms of one address. */
  const releasableIn = (messages: RawClaimMessage[]): OrganizerClaim[] =>
    ownClaimsIn(messages).filter((c) => c.nonce === nonce || stale(c));
  /** A record of ours this install cannot name AND cannot age out: a LIVE sibling lineage. */
  const unnameableIn = (messages: RawClaimMessage[]): OrganizerClaim[] =>
    ownClaimsIn(messages).filter((c) => c.nonce !== nonce && !stale(c));

  /* ── A RELEASE IS ADDRESSED BY (INSTALL, NONCE), NOT BY INSTALL ALONE ──────────────────────
   *
   * The election has always been nonce-scoped, because a restored image carries our install id
   * and a nonce we never generated: without the nonce it reads as ourselves, i.e. two organizers.
   * The release was id-scoped, and the asymmetry showed — a second profile of the same lineage
   * had its claim deleted by a sibling's stop. The clone defence is now symmetric on both paths.
   *
   * WITHOUT A NONCE THERE IS NO WIDER DELETE. An install that cannot name its claim refuses here
   * rather than falling back to the id: the caller logs it, the request stands on the row, and the
   * lapse bound in the worker's release arm records the release once the claim has been un-renewed
   * for a whole staleness window — by which time it is residue whoever wrote it. That is the way
   * out for the case this is most often reached in, and it costs one window rather than a
   * sibling's mailbox.
   *
   * THE GATE'S OWN EXPUNGE STAYS ID-SCOPED, and that is not an inconsistency left behind. Its
   * `ourRefs` is reused by the RENEW to clear our own superseded claims, which carry older nonces
   * by design, so narrowing it there leaks one claim per cycle — the comment at that branch says
   * so. A live sibling is caught one layer earlier anyway: the election reads a same-id foreign
   * nonce as a clone and stands this install down before it renews anything.
   */
  const found = await locate();
  const ours = releasableIn(found).map((c) => c.ref);
  if (ours.length > 0) await io.removeClaims(ours);

  /* ── THE CONFIRM, AND THE ONE RECORD IT MAY NOT CERTIFY OVER ──────────────────────────────
   *
   * `removeClaims` proves the uids it was handed are gone; the re-read is what proves nothing of
   * ours is left. A record of ours that is FRESH and carries a nonce we did not write is a live
   * sibling lineage — the mailbox is not free, and this install may neither delete it nor report
   * it away. The refusal keeps its own code so the caller can tell it from a folder it could not
   * read: the request stands, and the lapse bound records the release if the sibling stops
   * renewing. */
  const after = await locate();
  const left = releasableIn(after);
  if (left.length > 0) {
    throw new ClaimReleaseError(
      "still_present",
      `${left.length} releasable record(s) of this install's still stand in ${META_FOLDER} after `
      + `the delete removed ${ours.length} — the folder moved under the release, so it is not `
      + "confirmed and the next pass locates afresh",
    );
  }
  /* ── AND IT REFUSES ONLY WHEN IT ACCOMPLISHED NOTHING ─────────────────────────────────────
   *
   * This threw whenever an unnameable record stood, and that conflated two questions the rest of
   * this file keeps apart: "did THIS install give up its claim" — which the count answers, and
   * which is true even with a live sibling beside it — and "is the mailbox free", which is the
   * PEEK's to decide at the caller and which correctly withholds the row's stamp on any live
   * holder. Throwing over a completed release told the caller its own claim still stood.
   *
   * So the refusal is for the case where there was nothing this install could name or age out and
   * something of its id is still being renewed: nothing happened, and saying `0` would read as
   * "our claim was not there". */
  const unnameable = unnameableIn(after);
  if (ours.length === 0 && unnameable.length > 0) {
    throw new ClaimReleaseError(
      "nonce_unknown",
      `${unnameable.length} record(s) in ${META_FOLDER} carry this install's id under a nonce it `
      + "did not write and are still being renewed, so the mailbox is not free and this install "
      + "may not delete them. Another copy of this computer keeps organizing this mailbox until "
      + "its claim lapses, and the standing request is honoured by the lapse bound then",
    );
  }
  return ours.length;
}

/**
 * THIS ORGANIZER LOST THE MAILBOX WHILE IT WAS WRITING TO IT.
 *
 * Thrown by {@link LeasePermit.check}, and it is deliberately NOT the same class as
 * {@link LeaseUnavailableError}: "somebody else holds this now" and "I could not look" must not be
 * reachable from one another — the rule `ORGANIZER-LEASE-RESUME.md` §3.4 states for the gate, held
 * here for the re-check, because a pass that treated an unreadable lease as a takeover would stand
 * a mailbox down on a dropped connection.
 *
 * A pass that catches this and carries on has reopened the hole the permit exists to close. Every
 * `guard`/`check` seam in this repository is documented as ABORTING its pass — see
 * `junk-sweep.ts#junkSweepPass`'s write ask, whose contract already reads "a throw here aborts the
 * sweep — the members not yet moved are left exactly where they were" — so the honest stop was
 * designed for before there was anything to throw.
 */
export class OrganizerStandDownError extends Error {
  readonly reason: MailboxDisabledReason;
  readonly state: LeaseOccupancyState;
  readonly heldBy: string | null;
  /**
   * THE WINNING CLAIM ITSELF  — beside `heldBy`, which is only its display name.
   *
   * `heldBy` was enough while a stand-down wrote one column; the demotion now writes four, and
   * the other three (`kind`, `claimedAt`, and the occupancy above) come off the claim. Carried
   * rather than re-read, because the claim this verdict was reached from is the claim the row
   * should name — re-reading the folder to populate the columns would let the two disagree.
   */
  readonly by: OrganizerClaim | null;
  constructor(outcome: Extract<MailboxLeaseOutcome, { organize: false }>) {
    super(
      `this organizer no longer holds the mailbox (${outcome.reason}); ` +
      `the pass stops here rather than writing to a mailbox somebody else organizes`,
    );
    this.name = "OrganizerStandDownError";
    this.reason = outcome.reason;
    this.state = outcome.state;
    this.heldBy = outcome.by?.displayName ?? null;
    this.by = outcome.by;
  }
}

/**
 * HOW LONG A LEASE READ IS ALLOWED TO STAND FOR.
 *
 * The lease's own staleness window is ten minutes ({@link DEFAULT_STALE_AFTER_MS}) — how long a
 * claim stays fresh WITHOUT A RENEW. This is a different and much shorter number, and conflating
 * the two is the mistake: ten minutes is how long we believe somebody ELSE is still there, one
 * minute is how long we are willing to keep writing on the strength of a look we already took.
 *
 * A minute against an IMAP move measured in tens of milliseconds means the re-read is amortized
 * over a whole chunk of work rather than paid per message, and it bounds the overlap a takeover
 * can produce to one minute of writes instead of a whole pass.
 */
export const DEFAULT_PERMIT_TTL_MS = 60 * 1000;

/**
 * THE SHORTEST A PERMIT MAY BE — and it is a CORRECTNESS floor, not a cost one.
 *
 * ── TWO GATE RUNS IN THE SAME MILLISECOND MAKE AN ORGANIZER STAND ITSELF DOWN ────────────────
 *
 * Measured here, 2026-09-01, while building this permit, and reproduced with `runLeaseGate`
 * ALONE — no permit in the picture — by running the gate twice against one `ohmail/_meta` with the
 * SAME `now` and the nonce threaded exactly as `index.ts` threads it. Roughly one run in three:
 * the second call answers `stand_down` against a folder holding one claim, OUR OWN, bearing the
 * very nonce we passed as `lastNonce` — and because a stand-down RELEASES our claims, the folder
 * is left EMPTY. The organizer decides it is a clone of itself, stands down, and deletes the only
 * evidence that anybody was organizing the mailbox.
 *
 * The trigger is the shared instant: a renew appends a claim whose `heartbeat` and `claimedAt`
 * equal the one it replaces, so the two are separable only by nonce, and the outcome follows the
 * random nonce's ordering — which is why it looks like flakiness rather than a defect. With the
 * clock advanced thirty seconds between the two runs it did not reproduce once.
 *
 * NOTHING IN PRODUCTION REACHES IT TODAY: the worker runs the gate once per cycle, and
 * `reconcile-cron` once per process. This permit is the first caller that could ever run it twice
 * inside one millisecond, so the floor is here — the caller that would create the condition is the
 * one that refuses to. It is deliberately NOT a fix to the engine: the engine's tie-break is a
 * considered design (`compareStrength`'s total order exists because two clones once elected
 * themselves in a coin toss), and changing it from this lane would be editing a load-bearing
 * decision table to make a caller's test convenient. Filed as a sibling row instead.
 *
 * A caller asking for less gets this. A caller asking for zero — "check every time" — is asking
 * for precisely the condition above, and gets this too.
 */
export const MIN_PERMIT_TTL_MS = 1000;

/**
 * IS ANOTHER PROCESS WEARING MY INSTALL ID RENEWING RIGHT NOW? — the operator CLI's own question.
 *
 * ── `lastNonce: null` MEANS "TRUST ANYTHING WEARING MY ID", AND THE CLIs MEANT THE OPPOSITE ────
 *
 * Found by a review round over the commits that introduced the permit, 2026-09-01. It is a
 * caller-side defect with the engine behaving exactly as designed.
 *
 * `decideLease`'s `isOurs` reads (`organizer-lease.ts:603-610`):
 *
 *     if (c.installId !== self.installId) return false;
 *     const clonedUs = self.lastNonce !== null && c.nonce !== self.lastNonce && election.live.includes(c);
 *     return !clonedUs;
 *
 * With `lastNonce === null` the clone defence short-circuits, so **every** claim bearing our install
 * id is ours — including one another live process wrote a second ago. That is deliberate and
 * load-bearing: a worker that crashed and came back must recognise its own claim to resume its own
 * role, and it has no memory of the nonce it wrote. `cloudInstallId()` is a STABLE literal for the
 * same reason (see its docblock — a per-process id there would stand the fleet down on every deploy).
 *
 * Those two correct decisions compose into a wrong one in a tool that is neither the worker nor
 * fenced against it. `run-junk-sweep.ts` and `run-redacted-restore.ts` claim with the LIVE WORKER'S
 * OWN install id and no nonce, and they hold no leader lock — unlike `reconcile-cron.ts`, whose
 * identical construction is safe precisely because it takes the shard's lock first and therefore
 * only ever runs when no worker leads. So, against a live worker:
 *
 *  1. the CLI reads the worker's fresh claim W, matches it on install id, and `isOurs` says yes;
 *  2. arm 3 answers `organize` with `renew: true`, which appends nonce C and expunges W —
 *     **two organizers on one mailbox, the worst state in this system;**
 *  3. the worker's next gate holds W in memory, so C is a same-id claim with a foreign nonce: a
 *     restored clone. It stands ITSELF down, and a stand-down releases claims by install id, so it
 *     deletes C on the way out — **the folder is left empty while the CLI keeps moving mail on a
 *     TTL-cached permit, now with no claim at all.**
 *
 * ── THE FIX THAT LOOKED OBVIOUS, AND WHY IT IS WRONG ─────────────────────────────────────────
 *
 * Arming a SENTINEL nonce — a value we have provably never written, so `clonedUs` reduces to its
 * liveness half — was tried first and **is recorded here because its test caught it**, not because
 * it reasoned badly. The engine's liveness is **folder-relative**, measured from the newest
 * heartbeat *present in the folder* rather than from `now`:
 *
 *     const rawIsLive = (c) => newestHeartbeat - clamped < staleAfterMs;
 *
 * A folder holding ONE claim therefore has `newestHeartbeat === c.heartbeat`, so the difference is
 * zero and that claim is live **however old it is**. Under a sentinel, a worker's month-old claim on
 * a mailbox nobody has organized since is still "a live claim wearing my id" → arm 7 `stand_down`,
 * and the CLI refuses **exactly in the situation an operator runs it**: the worker is down and the
 * mailbox needs repair. The sentinel closes the dual-organizer hole by making the tool useless.
 *
 * That folder-relative rule is not a bug — it is what lets a lone stale claim stay rankable so an
 * authorized takeover has something to beat. It is simply not the question a one-shot tool is
 * asking.
 *
 * ── SO ASK THE QUESTION DIRECTLY, IN ABSOLUTE TIME, BEFORE THE GATE RUNS ─────────────────────
 *
 * The CLI wants to know one thing the decision table deliberately never asks: *is a process wearing
 * my install id renewing right now?* That is `now - heartbeat < staleAfterMs` — absolute, not
 * folder-relative — and it is answerable from the same claims the gate is about to read, with the
 * same parser (`parseClaim`, never a second header grep: a second parser here is how two readings of
 * one folder come to disagree about a folded header).
 *
 * Called BEFORE `acquireLeasePermit`, it leaves `lastNonce: null` in place and therefore changes
 * nothing about own-role resumption, the empty folder, or a foreign local claim — the gate decides
 * all three exactly as it did. The only case it changes is the one that was broken.
 *
 * Deliberately NOT an engine edit, on the same reasoning as {@link MIN_PERMIT_TTL_MS}: the decision
 * table is load-bearing and `compareStrength`'s total order was written to settle a real coin toss.
 * The caller that creates the condition is the caller that refuses it.
 *
 * ── THE RESIDUAL, WHICH IS A RACE AND NOT A HOLE ─────────────────────────────────────────────
 *
 * This is a check-then-act: a worker that begins renewing in the round trip between this read and
 * the gate's own is not seen, and two CLIs starting together do not see each other. The window is
 * one IMAP round trip against a guaranteed adoption, and closing it properly means the engine
 * answering absolute liveness itself — an architecture change to a decision table, not a caller's
 * repair. Written down rather than left for the next reader to discover.
 *
 * @throws {OrganizerStandDownError} a claim bearing `installId` was renewed within the window.
 * @throws {LeaseUnavailableError} the folder could not be read — NOT a stand-down.
 */
export async function assertNoLiveTwin(input: {
  adapter: MailboxAdapter;
  installId: string;
  now: Date;
  staleAfterMs?: number;
}): Promise<void> {
  const { adapter, installId, now } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // ── THE READ-ONLY IO, AND IT HAS TO BE THE READ-ONLY ONE ────────────────────────────────────
  //
  // This first used `leaseIo()`, the WRITE side, and that was wrong in the case these commands are
  // most often run in. `makeLeaseIo.listClaims()` goes straight to `getMailboxLock(_meta)` with no
  // ensure — the folder is created by `ensureMetaFolder`, which the gate calls and this does not —
  // so on a mailbox nobody has ever organized it rejects before `acquireLeasePermit` gets the chance
  // to create anything. **A legitimately unclaimed mailbox could not be repaired by either command,
  // which is the exact situation an operator reaches for them in.**
  //
  // `makeLeasePeekIo` is the read side and its docblock states the semantics this wants: it does not
  // create the folder, and an ABSENT folder is reported as zero claims — *"which is the truth:
  // nobody has ever organized this mailbox"*. Zero claims means no twin, which is the right answer.
  // Probed structurally, the way `hasLeaseIo` is, so an adapter without it degrades to a refusal
  // rather than to a silent pass.
  //
  // **`hasLeaseIo` is deliberately NOT also required here.** It was, briefly, and it was checking a
  // capability this function does not use — which is worse than not checking, because it reports
  // "cannot reach the folder" for an adapter that can read it perfectly well. The WRITE side is the
  // gate's precondition and `readMailboxLease` enforces it one statement later at both call sites,
  // so nothing is lost by asking only for what this actually needs.
  const peek = (adapter as Partial<LeasePeekCapableAdapter>).leasePeekIo;
  if (typeof peek !== "function") {
    throw new LeaseUnavailableError(
      `this mailbox's adapter cannot read ${META_FOLDER} without writing to it, so it cannot be ` +
      `checked for a live organizer sharing this process's install id`,
      // `no_lease_peek_io`, NOT `no_lease_io`: an adapter can have the write side and lack the
      // read-only one, and this branch fires on the second. Tagged with the first briefly, and a
      // review round caught it — the op is what sends an operator to a missing method, so naming the
      // wrong one is worse than naming none, which the union's REQUIRED field is designed to prevent.
      { op: "no_lease_peek_io" },
    );
  }

  // WRAPPED, so a transport fault reaches the callers' `LeaseUnavailableError` arm and gets the
  // SENTENCE that arm exists to print.
  //
  // Not the exit code, and this line said "the exit code and the sentence" until a second review
  // round checked it. **Both CLIs set `process.exitCode` and then rethrow, and the rethrow is
  // uncaught at top level, so node overrides it and exits 1.** The codes those arms select (3 for a
  // stand-down, 4 for an unreadable lease) reach no operator and no script: "held elsewhere",
  // "could not look" and "crashed" are one status to anything scripting these commands.
  //
  // That is older than this wrapper and is not this function's to fix — the repair belongs at the
  // top of each command, which must honour the chosen status AFTER its cleanup has run, since
  // exiting from inside the handler would skip closing the mail connection and the pool. What is
  // fixed here is the sentence: this line claimed the code as well as the message, and a comment
  // that overstates a protection is the thing this file has been correcting all day.
  //
  // Unwrapped, a dropped connection here surfaced as
  // a raw IMAP error through a `catch` that classifies neither — reported as no known refusal at all,
  // which is the one outcome §3.4 is written to prevent: "I could not look" must never be
  // indistinguishable from anything else.
  let messages;
  try {
    messages = await peek.call(adapter).listClaims();
  } catch (err) {
    throw new LeaseUnavailableError(
      `${META_FOLDER} could not be read, so it is unknown whether another organizer sharing this ` +
      `process's install id is live; nothing was written`,
      { op: "list_claims", cause: err },
    );
  }
  const twin = messages
    .map((m) => parseClaim(m.raw, m.ref))
    .find((c): c is OrganizerClaim =>
      c !== null && !isMalformed(c) && c.installId === installId
      // ABSOLUTE — measured from `now`, not from the newest heartbeat in the folder. That is the
      // entire difference between this and the engine's own liveness, and the reason this function
      // exists.
      //
      // NO FORWARD CLAMP, and its absence is deliberate. One was written here first, mirroring
      // `decideLease`'s `Math.min(heartbeat, now + MAX_FUTURE_SKEW_MS)`, and a mutation run proved it
      // could not change an outcome: for any heartbeat `h`, `min(h, now) > now - stale` is TRUE
      // exactly when `h > now - stale` is. It was redundant, and a redundant guard reads as a
      // protection somebody is relying on. The engine needs its clamp because a future-dated claim
      // could wrongly WIN an election there; here the untruthful direction is already the safe one.
      //
      // The cost of no clamp, stated rather than discovered: a claim stamped in 2099 wearing this
      // install id makes this refuse for ever, so a machine with a broken clock can jam the operator
      // CLIs. It is fail-SAFE (nothing writes to the mailbox) and it is the same exposure
      // `decideLease` answers with its `plausible` gate, which a caller cannot reach. Not fixed here;
      // named so the next reader does not have to find it.
      && c.heartbeat.getTime() > now.getTime() - staleAfterMs);

  if (!twin) return;
  throw new OrganizerStandDownError({
    organize: false,
    // It IS a cloud organizer — it is wearing this process's own cloud install id. The closed set
    // has no member for "another copy of me", and inventing one would widen a column's taxonomy
    // from a CLI. `held` because we have just measured that it is still being renewed.
    reason: "organized_elsewhere:cloud",
    state: "held",
    by: twin,
  });
}

/**
 * A LEASE READ, WITH A DEADLINE ON IT — the thing a destructive pass carries instead of a boolean.
 *
 * ── WHY A PERMIT AND NOT A CHECK AT THE TOP ──────────────────────────────────────────────────
 *
 * Exactly one active organizer per mailbox is the invariant CLAUDE.md names load-bearing, and a
 * pass that reads the lease once and then writes for minutes is not enforcing it — it is
 * enforcing "exactly one organizer at the instant this pass began". The window between those two
 * statements is where a takeover lands: the user moves the mailbox to their own machine, that
 * install claims `ohmail/_meta`, and this process keeps moving their mail because nothing asked
 * again.
 *
 * So the answer carries an expiry, and the pass asks it at every write boundary. Inside the TTL
 * the ask is free (a comparison); past it, it is one `runLeaseGate` — which also RENEWS our claim,
 * so a long pass keeps its own lease fresh instead of ageing into staleness while it works.
 *
 * ── THE NONCE IS CARRIED, NEVER RE-ARMED ─────────────────────────────────────────────────────
 *
 * `LeaseSelf.lastNonce` is the clone defence's memory: a claim bearing our install id whose nonce
 * is not the one we wrote is a second live process wearing our identity. A permit that re-verified
 * with `lastNonce: null` would tell the gate "fresh start, trust anything with my id" on every
 * re-check — which is precisely the case the nonce exists to catch, disarmed once a minute. So the
 * permit owns the nonce and threads each renew's into the next read.
 */
export interface LeasePermit {
  /**
   * MAY THIS PASS STILL WRITE TO THE MAILBOX? Returns on yes; throws on no.
   *
   * @throws {OrganizerStandDownError} another organizer holds the mailbox now.
   * @throws {LeaseUnavailableError} the lease could not be read — NOT a stand-down.
   */
  check(): Promise<void>;
  /** Who this permit is for, and under which claim — the five facts the invariant names. */
  readonly names: PermitIdentity;
  /** When the lease was last actually read. Test-visible so a TTL claim can be watched to fail. */
  readonly verifiedAt: Date;
  /** How many times the lease was re-read (as against served from inside the TTL). */
  readonly reads: number;
  /** Write boundaries passed since the last re-read — the second trigger beside the clock. */
  readonly writesSinceRead: number;
  /** TRUE once a stand-down has killed this permit. A dead permit is never revived. */
  readonly revoked: boolean;
}

/** The five facts a permit names, so a write can say which claim it is riding. */
export interface PermitIdentity {
  readonly installId: string;
  readonly mailboxId: string;
  readonly uidValidity: number | bigint | null;
  readonly nonce: string | null;
  readonly issuedAt: Date;
}

export interface LeasePermitInput extends Omit<MailboxLeaseInput, "now"> {
  /** The clock, injectable so a test can drive the TTL without sleeping. */
  now?: () => Date;
  /**
   * See {@link DEFAULT_PERMIT_TTL_MS}. Clamped UP to {@link MIN_PERMIT_TTL_MS} — a shorter permit
   * is not "more careful", it is the same-instant re-entry that arm's docblock measures.
   */
  ttlMs?: number;
  /** See {@link PERMIT_WRITES_PER_RECHECK}. Clamped UP to 1; 0 would mean "never re-read". */
  writesPerRecheck?: number;
  /**
   * A GATE READ THIS CALLER HAS ALREADY TAKEN, adopted as the permit's first look.
   *
   * The gate is itself a WRITE — it renews our claim — so a caller that has just run it hands the
   * result over rather than running it again: two gate runs inside one millisecond is exactly the
   * self-stand-down {@link MIN_PERMIT_TTL_MS} refuses. `at` is the instant that read was taken,
   * because the TTL is measured from the look, not from this call.
   */
  adopt?: { outcome: Extract<MailboxLeaseOutcome, { organize: true }>; at: Date };
}

/**
 * TAKE THE LEASE, AND KEEP A DATED RECEIPT FOR IT.
 *
 * Throws {@link OrganizerStandDownError} when the mailbox is already somebody else's — so a caller
 * that forgets to handle the refusal fails loudly rather than sweeping on, which is the direction
 * an operator CLI's error handling should fail in.
 */
export async function acquireLeasePermit(input: LeasePermitInput): Promise<LeasePermit> {
  const clock = input.now ?? ((): Date => new Date());
  const ttlMs = Math.max(input.ttlMs ?? DEFAULT_PERMIT_TTL_MS, MIN_PERMIT_TTL_MS);
  const writesPerRecheck = Math.max(input.writesPerRecheck ?? PERMIT_WRITES_PER_RECHECK, 1);
  const base = { ...input };
  delete (base as Partial<LeasePermitInput>).now;
  delete (base as Partial<LeasePermitInput>).ttlMs;
  delete (base as Partial<LeasePermitInput>).writesPerRecheck;
  delete (base as Partial<LeasePermitInput>).adopt;

  // The nonce this permit has written, threaded into every later read — see the docblock.
  let lastNonce: string | null = input.self.lastNonce;
  let verifiedAt: Date;
  let issuedAt: Date;
  let uidValidity: number | bigint | null = null;
  let reads = 0;
  let writesSinceRead = 0;
  let revoked = false;

  const read = async (): Promise<void> => {
    const at = clock();
    reads++;
    // A read that THROWS leaves every field below untouched, which is the wanted behaviour: an
    // unreadable lease is not a stand-down (both call sites exempt `LeaseUnavailableError` by
    // class), and recording it as a fresh look would serve the stale receipt for a whole new TTL
    // on the strength of a read that failed.
    const outcome = await readMailboxLease({
      ...base,
      self: { ...input.self, lastNonce },
      now: at,
    } as MailboxLeaseInput);
    if (!outcome.organize) {
      // ── A STAND-DOWN KILLS THE PERMIT, AND IT STAYS DEAD ──────────────────────────────────
      //
      // Without this latch the throw leaves `verifiedAt` stale, so the very next `check()` re-reads
      // and can be re-admitted — a permit surviving the stand-down that revoked it. The mailbox may
      // legitimately come back to this install later; it comes back through a NEW permit, taken by
      // a gate that ran, never by reviving this receipt.
      revoked = true;
      throw new OrganizerStandDownError(outcome);
    }
    // ── THE GENERATION IS PART OF THE RECEIPT, NOT A DETAIL ──────────────────────────────────
    //
    // A uid remembered under one UIDVALIDITY names a different message or none at all under the
    // next, so a renumbering between two reads voids every ref this permit's claim was addressed
    // by. Recorded, and compared at `check()`: a CHANGED known generation forces a re-read whatever
    // the clock says. Two `null`s are not a match — unknown is not "the same".
    uidValidity = outcome.uidValidity;
    lastNonce = outcome.nonce;
    verifiedAt = at;
    writesSinceRead = 0;
  };

  if (input.adopt) {
    uidValidity = input.adopt.outcome.uidValidity;
    lastNonce = input.adopt.outcome.nonce;
    verifiedAt = input.adopt.at;
    reads = 1;
  } else {
    await read();
  }
  issuedAt = verifiedAt!;

  return {
    get names(): PermitIdentity {
      return {
        installId: input.self.installId, mailboxId: input.mailboxId,
        uidValidity, nonce: lastNonce, issuedAt,
      };
    },
    get verifiedAt(): Date { return verifiedAt; },
    get reads(): number { return reads; },
    get writesSinceRead(): number { return writesSinceRead; },
    get revoked(): boolean { return revoked; },
    async check(): Promise<void> {
      if (revoked) {
        throw new OrganizerStandDownError({
          organize: false,
          // The reason this permit DIED is not re-derivable here — the claim that beat us was
          // carried by the throw that revoked it. `unknown` is the honest name for "somebody else
          // holds it and this receipt is spent", and it is what the row already holds.
          reason: "organized_elsewhere:unknown", state: "held", by: null,
        });
      }
      writesSinceRead++;
      // `>=` and not `>` on both triggers: a permit is expired AT its deadline, not one tick after
      // it. On a host with coarse timer resolution `>` serves the deadline instant itself from the
      // stale receipt, and a takeover landing exactly on it is missed for another whole TTL.
      // `lease-permit.test.ts` drives the clock to exactly `ttlMs` and to exactly the write count,
      // and both cases fail if either comparison is loosened.
      const stale = clock().getTime() - verifiedAt.getTime() >= ttlMs;
      const worked = writesSinceRead >= writesPerRecheck;
      if (stale || worked) await read();
    },
  };
}

/**
 * HOW MANY WRITE BOUNDARIES A PERMIT MAY COVER BEFORE IT IS RE-READ — the clock's other half.
 *
 * The TTL bounds the overlap a takeover can produce IN TIME. It does not bound it in WRITES, and
 * those are the units the person loses: a batch pass can file several hundred messages inside one
 * minute, so a purely time-based permit lets a whole chunk of somebody else's mailbox move on one
 * look. This is the second trigger, and either one alone is insufficient.
 *
 * 100 rather than 1: the re-read is an IMAP round trip that also RENEWS, and asking per message
 * would cost more round trips than the filing itself. At a filing budget of 500 per cycle it is
 * five extra reads for a whole pass.
 */
export const PERMIT_WRITES_PER_RECHECK = 100;

/**
 * MAY A DESTRUCTIVE IMAP WRITE BE ISSUED RIGHT NOW? — the ONE predicate every write site asks.
 *
 * Two questions, asked in this order and never merged into one answer. LEADERSHIP first
 * (worker-to-worker: does this process still lead its shard?) because a re-read of the lease
 * RENEWS our claim, which is itself a write — a fenced worker must not renew. Then the LEASE
 * (install-to-install: does this install still hold the mailbox?).
 *
 * A census over both organizing roots asserts that every destructive verb there is preceded by
 * this call and that there is exactly one definition of it, so a new write site cannot arrive
 * without an author placing it.
 */
export async function assertMayWriteToMailbox(authority: MailboxWriteAuthority): Promise<void> {
  if (authority.fence) await authority.fence();
  if ("check" in authority.lease) await authority.lease.check();
}

/**
 * WHAT AUTHORISES THIS PASS'S WRITES. Built once per cycle at a composition root.
 *
 * `lease` is a permit or a NAMED statement that this composition holds none — never an absent
 * field, because "not answered yet" and "there is no such thing here" have to stay
 * distinguishable at the write boundary.
 */
export interface MailboxWriteAuthority {
  /**
   * The leadership check, or absent for a composition with no shard leadership to lose (the
   * desktop engine, the reconcile cron). Supplied as a closure so this module needs nothing from
   * the sync pass, whose `LeaderFencedError` the closure throws.
   */
  readonly fence?: (() => Promise<void>) | undefined;
  readonly lease: LeasePermit | NoOrganizerLease;
}

/**
 * THE LEASE HALF, as a composition root supplies it — a permit, or the reason there is none.
 *
 * The root is where the role is known, so the root decides; `sync.ts` adds the leadership half it
 * owns and never re-derives this one.
 */
export type OrganizerWriteAuthority = LeasePermit | NoOrganizerLease;

/** Why a pass holds no organizer lease. Every arm is a state somebody can point at. */
export interface NoOrganizerLease {
  readonly noLease:
    /** A READER: it holds no lease, and `\Seen` is the one verb it may write (`sync.ts`). */
    | "reader"
    /** The adapter cannot reach `ohmail/_meta`, so no lease is readable from this composition. */
    | "adapter_cannot_reach_meta"
    /**
     * NOBODY SUPPLIED ONE. A fixture reaches this; a production root must not, and the write-permit
     * census is what refuses it there — asserting both composition roots pass a `writeAuthority`.
     * Named rather than silent so a diagnosis has something to read.
     */
    | "not_supplied";
}

/** Re-exported so the worker's `catch` arms name one class, imported from one place. */
export { LeaseUnavailableError, ClaimReleaseError, DEFAULT_STALE_AFTER_MS, META_FOLDER };
export type { ClaimReleaseFailureCode } from "@trafficflow/core/adapters/organizer-lease";
export type { LeaseSelf, OrganizerClaim, LeaseOp };
export type { LeasePeek, LeaseHolder, LeaseOccupancy } from "@trafficflow/core/adapters/organizer-lease";
