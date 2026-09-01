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
