import {
  DEFAULT_STALE_AFTER_MS, LeaseUnavailableError, META_FOLDER, isMalformed, parseClaim, runLeaseGate,
  type LeaseIo, type LeaseOp, type LeaseSelf, type LeaseVerdict, type OrganizerClaim,
  type TakeoverAuthorization,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
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
export const CLOUD_INSTALL_ID_PREFIX = "ohmail-cloud";

/** The default `X-Ohmail-Install-Id` for a Cloud worker in the given environment. */
export function cloudInstallId(environment: string): string {
  return `${CLOUD_INSTALL_ID_PREFIX}:${environment}`;
}

/**
 * How the claim names us to a human who opens `ohmail/_meta` in another mail client.
 *
 * §4's takeover prompt reads `ohmail on <machine> organizes this mailbox`, so the string has to
 * be a place and not an id. For Cloud the place is Cloud.
 */
export const CLOUD_DISPLAY_NAME = "ohmail Cloud";

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
  leaseIo(): LeaseIo;
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
 * ── IT IS CORRECT WHEN PRODUCED AND STALE ONE MINUTE LATER, SO IT IS NEVER PERSISTED ───────
 *
 * A mailbox that has been stood down is `status='disabled'`, and `loadEnabledMailboxes` filters
 * those out — so nothing re-reads its lease, ever, until a human asks for it. A `held` written to
 * a column would therefore be frozen at the instant of the stand-down and would keep saying
 * "somebody is organizing this" long after they stopped. That is the same half-truth
 * `mailbox-errors.ts` removes when it makes every writer clear the statements its write
 * falsifies, and the fix there does not transfer: there is no later writer to clear this one.
 *
 * So it is carried, logged and returned, and the durable answer to "who holds this mailbox now"
 * is obtained by LOOKING AGAIN at the moment somebody asks — `readLeasePeek`.
 */
export type LeaseOccupancyState = "held" | "stopped";

/**
 * The verdict, reduced to what the worker acts on.
 *
 * `organize: false` carries a reason, always — the worker's stand-down write has nowhere to put
 * "I do not know", and `organized_elsewhere:unknown` is the honest name for that case anyway.
 */
export type MailboxLeaseOutcome =
  | { organize: true; nonce: string | null; by: null }
  | {
    organize: false;
    reason: MailboxDisabledReason;
    state: LeaseOccupancyState;
    by: OrganizerClaim | null;
  };

export interface MailboxLeaseInput {
  adapter: MailboxAdapter;
  self: LeaseSelf;
  now: Date;
  takeover?: TakeoverAuthorization;
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
    io: adapter.leaseIo(),
    self,
    now,
    ...(input.takeover !== undefined ? { takeover: input.takeover } : {}),
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    ...(input.log !== undefined ? { log: input.log } : {}),
  });

  if (result.verdict.verdict === "organize") return { organize: true, nonce: result.nonce, by: null };
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
export async function releaseMailboxClaim(adapter: MailboxAdapter, installId: string): Promise<number> {
  if (!hasLeaseIo(adapter)) return 0;
  const io = adapter.leaseIo();
  const messages = await io.listClaims();
  const ours = messages
    .map((m) => ({ ref: m.ref, claim: parseClaim(m.raw, m.ref) }))
    .filter((c) => c.claim !== null && !isMalformed(c.claim) && c.claim.installId === installId)
    .map((c) => c.ref);
  if (ours.length === 0) return 0;
  await io.removeClaims(ours);
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
 * `junk-sweep.ts#junkSweepPass`'s `guard`, whose contract already reads "a throw here aborts the
 * sweep — the members not yet moved are left exactly where they were" — so the honest stop was
 * designed for before there was anything to throw.
 */
export class OrganizerStandDownError extends Error {
  readonly reason: MailboxDisabledReason;
  readonly state: LeaseOccupancyState;
  readonly heldBy: string | null;
  constructor(outcome: Extract<MailboxLeaseOutcome, { organize: false }>) {
    super(
      `this organizer no longer holds the mailbox (${outcome.reason}); ` +
      `the pass stops here rather than writing to a mailbox somebody else organizes`,
    );
    this.name = "OrganizerStandDownError";
    this.reason = outcome.reason;
    this.state = outcome.state;
    this.heldBy = outcome.by?.displayName ?? null;
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
      { op: "no_lease_io" },
    );
  }

  // WRAPPED, so a transport fault reaches the callers' `LeaseUnavailableError` arm and gets the exit
  // code and the sentence that arm exists to print. Unwrapped, a dropped connection here surfaced as
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
  /** When the lease was last actually read. Test-visible so a TTL claim can be watched to fail. */
  readonly verifiedAt: Date;
  /** How many times the lease was re-read (as against served from inside the TTL). */
  readonly reads: number;
}

export interface LeasePermitInput extends Omit<MailboxLeaseInput, "now"> {
  /** The clock, injectable so a test can drive the TTL without sleeping. */
  now?: () => Date;
  /**
   * See {@link DEFAULT_PERMIT_TTL_MS}. Clamped UP to {@link MIN_PERMIT_TTL_MS} — a shorter permit
   * is not "more careful", it is the same-instant re-entry that arm's docblock measures.
   */
  ttlMs?: number;
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
  const base = { ...input };
  delete (base as Partial<LeasePermitInput>).now;
  delete (base as Partial<LeasePermitInput>).ttlMs;

  // The nonce this permit has written, threaded into every later read — see the docblock.
  let lastNonce: string | null = input.self.lastNonce;
  let verifiedAt: Date;
  let reads = 0;

  const read = async (): Promise<void> => {
    const at = clock();
    reads++;
    const outcome = await readMailboxLease({
      ...base,
      self: { ...input.self, lastNonce },
      now: at,
    } as MailboxLeaseInput);
    if (!outcome.organize) throw new OrganizerStandDownError(outcome);
    lastNonce = outcome.nonce;
    verifiedAt = at;
  };

  await read();

  return {
    get verifiedAt(): Date { return verifiedAt; },
    get reads(): number { return reads; },
    async check(): Promise<void> {
      // `>=` and not `>`: a permit is expired AT its deadline, not one tick after it. The
      // difference is not academic on a host whose timer resolution is coarse — there, `>` means
      // the deadline instant itself is served from the stale receipt, and a takeover that lands
      // exactly on it is missed for another whole TTL. The boundary is where the answer changes,
      // so the boundary is what the test pins: `lease-permit.test.ts` drives the clock to exactly
      // `ttlMs` and asserts the lease is re-read, and it fails if this comparison is loosened
      // to `>`.
      if (clock().getTime() - verifiedAt.getTime() >= ttlMs) await read();
    },
  };
}

/** Re-exported so the worker's `catch` arms name one class, imported from one place. */
export { LeaseUnavailableError, DEFAULT_STALE_AFTER_MS, META_FOLDER };
export type { LeaseSelf, OrganizerClaim, LeaseOp };
export type { LeasePeek, LeaseHolder, LeaseOccupancy } from "@trafficflow/core/adapters/organizer-lease";
