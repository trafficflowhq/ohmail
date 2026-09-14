import {
  CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_PROFILE, CAPABILITY_RULES, deriveRequestKey,
  DEFAULT_STALE_AFTER_MS, LeaseUnavailableError, LeaseClockSkewError, META_FOLDER,
  ClaimReleaseError,
  isMalformed, parseClaim, runLeaseGate, sameMetaStamp,
  type LeaseIo, type LeaseOp, type LeaseSelf, type LeaseVerdict, type MetaBaselineReading,
  type MetaFolderStamp,
  type OrganizerClaim,
  type RawClaimMessage,
  type TakeoverAuthorization,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { ImapAuth } from "@trafficflow/core/adapters/imap-types";
import type { MailboxDisabledReason, MailboxSyncBlockReason } from "@trafficflow/db";

/**
 * The worker's half of the organizer lease — composition, and nothing else.
 * `packages/core/src/adapters/organizer-lease.ts` is the engine (the claim format, the decision table,
 * the IO). It shipped with a two-worlds GreenMail test and ZERO callers — this repository's named
 * failure pattern, built-tested-unreachable — while a deployed worker organized mailboxes with no
 * claim in `ohmail/_meta` at all, because nothing on this side ever asked. This module ends that and
 * adds no policy the engine does not already have: it resolves who we are, hands the engine its IO, and
 * translates the verdict into the two things the worker can do about it. The engine is NOT edited to
 * make this wiring easier — every awkwardness here is awkward here on purpose.
 */

/**
 * Who Cloud is, as an organizer — and the single most dangerous constant in this file. The install id
 * is what `decideLease` matches on to answer "is that claim MINE?". Get it wrong in the unstable
 * direction and every worker restart looks like a NEW organizer arriving: the incoming process reads
 * the outgoing one's fresh `cloud` claim as FOREIGN, falls through to `available`, and DISABLES the
 * mailbox — a failover taking a customer's mail offline on the deploy that introduced the safety net.
 * So it is a literal, stable by construction: never from `instanceId` (per-process), never from the
 * database (a cutover would disable every live mailbox), and SCOPED by environment (staging on a
 * production mailbox is a different organizer). `TF_ORGANIZER_INSTALL_ID` overrides it for a self-hosted Cloud.
 */
/* One definition, in `@trafficflow/core`. It moved there because the API tier decides the same
   question — "is the claim on this mailbox ours" — and answering it with the KIND rather than the id
   is what let a release clear a row over another Cloud deployment's claim. Re-exported here so every
   existing importer of this module is unchanged. NAMED AT ITS LEAF (`/organizer-install`) rather than
   at the package root, not a style choice: this module is bundled into the desktop engine, and a VALUE
   re-export is a runtime edge the bundler keeps — spelled `from "@trafficflow/core"` it pulled that
   package's index, whose `export *` conveys the whole AI runtime and the hosted database half and the
   PostgreSQL driver (37 extra modules in a public download, which the engine build refuses over). The
   leaf named here imports nothing, which is what makes it safe to reach from a module the engine carries. */
export { CLOUD_INSTALL_ID_PREFIX, cloudInstallId, organizerEnvironment, resolveCloudInstallId } from "@trafficflow/core/organizer-install";

/**
 * How the claim names us to a human who opens `ohmail/_meta` in another mail client.
 *
 * §4's takeover prompt reads `ohmail on <machine> organizes this mailbox`, so the string has to
 * be a place and not an id. For Cloud the place is Cloud.
 */
export const CLOUD_DISPLAY_NAME = "ohmail Cloud";

/**
 * What an organizer running this code offers a reader — written onto every claim this composition
 * renews, and the only place either door decides it. ONE CONSTANT, because both the hosted worker and
 * the desktop engine reach the lease through {@link readMailboxLease}, so the advertised set is a
 * property of THIS module — two spellings would be a capability a reader detects on Cloud and not on a
 * desktop. Deliberately not injectable: a per-call narrowing could advertise less than the build
 * supports, invisibly and inconsistently across mailboxes on one install. What the BUILD supports is
 * not what an account can use (0090): "can this code drain a request" differs from "is there a shared
 * secret to sign one", so a mailbox with no key must not advertise `requests` ({@link organizerCapabilitiesFor}).
 */
export const ORGANIZER_CAPABILITIES: readonly string[] = [
  CAPABILITY_REQUESTS, CAPABILITY_MOVES, CAPABILITY_PROFILE, CAPABILITY_RULES,
];

/* Why `moves` joins the set here and not earlier (mail 0094). A capability means "this build has an
   applier for that kind of request". `message.move` got its applier and its dispatch-table entry
   first; the advertisement lands after, and that ORDER is the whole promise — advertised first, a
   reader reads `capable: true`, writes a record this organizer has no code to drain, and the person
   watches a message sit pending until it expires. `profile` joined the same way one slice later,
   `rules` after, each in the same commit as its applier. The set is COMPLETE for the kinds mail 0094
   admits, so the standing path is reached only by a FUTURE kind. The three `rule.*` kinds share ONE
   capability because they share one applier. Still not injectable and still through
   {@link organizerCapabilitiesFor}, so a mailbox with no key advertises NOTHING — including `moves`. */

/**
 * What this organizer advertises for this account — no key means no capability, and this is the one
 * place that rule is applied. An organizer with no derived key (an OAuth mailbox, each install holding
 * its own token) advertises NOTHING, and a reader then reads `organizer_outdated` off the row and
 * refuses the press honestly at its own door — the complete degraded mode: no request queued, no
 * record written, nothing waiting for a drain that could never verify it. The capability header is
 * ADVISORY and never the gate: it is copied from a claim anyone with APPEND rights can write, so an
 * attacker can make a reader BELIEVE an organizer is capable — and that buys nothing, because the
 * reader appends a record signed with a key it holds and the organizer either holds the same key or refuses it.
 */
export function organizerCapabilitiesFor(o: { hasRequestKey: boolean }): readonly string[] {
  return o.hasRequestKey ? ORGANIZER_CAPABILITIES : [];
}

/**
 * Does this mailbox have a request key — the one question `organizerCapabilitiesFor` needs. A thin name
 * over {@link deriveRequestKey}, kept because four hosted processes renew the SAME claim
 * (`cloudInstallId` is deliberately shared, so a per-process id cannot stand the worker down) and must
 * advertise the SAME set — a backstop that renewed the claim without `requests` while the worker
 * renewed it with would make the capability appear and disappear under readers depending on which
 * process last ran. Nothing to mint and nothing to fail: the key is HKDF over the mailbox password, a
 * pure function of a credential already decrypted. An OAuth mailbox answers `false`, the honest
 * degraded mode.
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
 * Is somebody else still renewing, or did they stop? `held` — a live foreign claim (the engine's
 * `stand_down`); `stopped` — somebody WAS organizing and nothing has renewed since (`available`). The
 * engine has three verdicts and this used to collapse two into one `organize: false`, making "Cloud is
 * organizing this" and "Cloud stopped organizing this" the same value — and those want opposite actions
 * offered. PERSISTED since mail 0083: the old argument (a stood-down mailbox is `disabled` and filtered
 * out, so a column would freeze) followed from a premise now false — a loser is a READER, connected and
 * cycling, so every reader cycle refreshes `mailboxes.organizer_state` from a `readLeasePeek`. The
 * value is still carried; the ROW is what every banner reads, and `readLeasePeek` is the live answer.
 */
export type LeaseOccupancyState = "held" | "stopped";

/**
 * The verdict, reduced to what the worker acts on.
 *
 * `organize: false` carries a reason, always — the worker's stand-down write has nowhere to put
 * "I do not know", and `organized_elsewhere:unknown` is the honest name for that case anyway.
 */
export type MailboxLeaseOutcome =
  | {
    organize: true; nonce: string | null; by: null; uidValidity: number | bigint | null;
    /**
     * THE FOLDER'S COUNTERS AS THIS CLAIM WAS VERIFIED, AND THE PROOF THAT THEY ARE ITS OWN — issued
     * by the gate, awaited by whoever needs it. A permit's baseline and the claim it rides have to be
     * ONE ACT: taken later, a take-over landing in between is baked into the baseline, and every write
     * boundary then reads "nothing moved" while somebody else moves the folder, for a whole TTL or a
     * hundred writes. A STATUS issued here, after the gate returned, was still a separate round trip
     * and still had that gap in front of it — so the gate takes the counters itself and re-proves
     * custody by nonce behind them ({@link MetaBaselineReading}). NOT awaited by the gate: the row that
     * follows the claim is written next by both adopt callers with nothing awaited in front of it, and
     * that window is what they exist to close.
     */
    stamp: Promise<MetaBaselineReading>;
  }
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
  /** See {@link LeaseGateInput.onNonceMinted} — the identity moves with the write, not the answer. */
  onNonceMinted?: (nonce: string) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * Read the lease, and say whether this process may organize this mailbox. An adapter with no `leaseIo`
 * is a lease we CANNOT READ: it throws {@link LeaseUnavailableError} rather than defaulting to
 * "organize". That default is the whole bug this lease exists to close — a gate whose absent dependency
 * selects the permissive branch stops existing the first time somebody composes the worker slightly
 * differently, with nothing saying so. Production always gets an `ImapAdapter`, and the suite's fake
 * fleet grows a real in-memory `leaseIo` for the same reason, so the gate is EXERCISED by every worker
 * test. The cost is bounded: `LeaseUnavailableError` is exempted BY CLASS at both call sites, so a
 * mailbox whose lease cannot be read does not sync and is NOT quarantined for it.
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

  /* Every line the gate writes names the mailbox, and it is bound here for both hosts. `runLeaseGate`
   * is deliberately mailbox-agnostic — it works through `io` against one mailbox's `_meta` and holds no
   * id — so its lines said what happened and never what it happened TO, and `lease_stand_down` is a
   * PER-MAILBOX verdict, which on an install holding more than one made the record unreadable: a
   * handover nobody can attribute from the log it leaves. Bound once here rather than at each of the
   * gate's call sites, because both hosts reach the gate through this function and neither should have
   * to remember. `mailboxId` goes FIRST so a line that already carries one keeps its own value. */
  const caller = input.log;
  const leaseLog = caller === undefined
    ? undefined
    : (event: string, detail: Record<string, unknown>): void => {
      caller(event, { mailboxId: input.mailboxId, ...detail });
    };

  /* ONE HANDLE for the gate and for the reading taken the moment its last write lands: a second
     one would re-resolve the folder's path, and the reading has to be the next thing on this
     connection after the renew. */
  const io = adapter.leaseIo({ installId: self.installId, mailboxId: input.mailboxId });
  const result = await runLeaseGate({
    io,
    self,
    now,
    capabilities: organizerCapabilitiesFor({ hasRequestKey: input.hasRequestKey }),
    ...(input.takeover !== undefined ? { takeover: input.takeover } : {}),
    ...(input.staleAfterMs !== undefined ? { staleAfterMs: input.staleAfterMs } : {}),
    ...(input.onNonceMinted !== undefined ? { onNonceMinted: input.onNonceMinted } : {}),
    ...(leaseLog !== undefined ? { log: leaseLog } : {}),
  });

  if (result.verdict.verdict === "organize") {
    return {
      organize: true, nonce: result.nonce, by: null, uidValidity: result.uidValidity,
      // THE GATE'S OWN READING, CARRIED — never a STATUS taken here. Issued by the gate the instant
      // its last write landed and proved against the claim it admitted; asking for it here would be
      // a second act with the whole of `runLeaseGate`'s return path in front of it, which is the
      // window a takeover landed in. The `catch` is belt: the contract answers rather than throwing,
      // and an unhandled rejection on a promise a caller is entitled to ignore would be this
      // function's fault rather than the connection's.
      stamp: result.stamp.catch((): MetaBaselineReading => ({ custody: "unproven" })),
    };
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
 * The engine's verdict, as the closed set `mailboxes.disabled_reason` holds. The two unions meet here
 * and the compiler is the proof: `StandDownReason` (`packages/core`) and `MailboxDisabledReason`
 * (`@trafficflow/db`) are the same strings written twice, and they have to be (the engine tier may not
 * import the private half), so the reconciliation is a typed assignment at the one place the two meet
 * (a member on either side the other lacks fails `tsc`) plus a runtime set-equality test, so a DB-side
 * widening TypeScript would accept still stops the suite. `available` is a stand-down for the worker
 * even though the engine calls it a third verdict: BECOMING an organizer always requires an explicit
 * human action, and `available` means nobody is organizing and nobody authorized us to start.
 */
function standDownReason(verdict: Exclude<LeaseVerdict, { verdict: "organize" }>): MailboxDisabledReason {
  if (verdict.verdict === "stand_down") {
    const reason: MailboxDisabledReason = verdict.reason;
    return reason;
  }
  // EVERY KIND ON ITS OWN ARM, `reasonFor`'s rule one tier over: a `mobile` holder folded into
  // `:unknown` would tell a person "another ohmail organizer" about a phone, and the phone is the
  // holder whose answer differs — it organizes only while it is open.
  const kind = verdict.by?.kind;
  return kind === "cloud" ? "organized_elsewhere:cloud"
    : kind === "local" ? "organized_elsewhere:local"
      : kind === "mobile" ? "organized_elsewhere:mobile"
        : "organized_elsewhere:unknown";
}

/**
 * What an unreadable lease is CALLED on the mailbox row.
 *
 * ONE derivation for both arms of the sync loop — the attach and the cycle — because the two used
 * to spell `"lease_unreadable"` as a literal each. A wrong clock is not a folder that could not be
 * read: `lease_unreadable`'s sentence says ohmail cannot read its own folder on that server, which
 * is false here and names nothing anybody can act on, while the one thing a person can do about a
 * wrong clock is set it. Every other `LeaseUnavailableError` keeps the answer it had.
 */
export function leaseBlockReason(err: LeaseUnavailableError): MailboxSyncBlockReason {
  return err instanceof LeaseClockSkewError ? "clock_off" : "lease_unreadable";
}

function byOf(verdict: Exclude<LeaseVerdict, { verdict: "organize" }>): OrganizerClaim | null {
  return verdict.by;
}

/**
 * Delete this organizer's own claims from a mailbox it is ceasing to organize. Returns how many were
 * removed. NOT a stand-down: nobody won this mailbox from us, we stopped being entitled to it (the
 * account lapsed, the user disconnected it, the cap evicted it), and the claim has to go so the user's
 * own machine can take the mailbox over without waiting out a staleness window it cannot see the end of.
 * `parseClaim` rather than a header grep, so "is this ours" is answered by the same code that answers
 * it inside the gate (a second parser is how the two come to disagree about a folded header). An adapter
 * with no `leaseIo` releases nothing and says so with a 0 rather than throwing: this runs on a teardown
 * path, and a teardown must not be abortable by bookkeeping.
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
  opts: {
    staleAfterMs?: number;
    now?: Date;
    /**
     * THE NONCE A RENEWAL MINTED AND GOT NO ANSWER ABOUT — the second value this install can name
     * as its own. A claim left by a lost response is ours and has to leave with the rest, or the
     * person's stop clears everything except the record that is actually holding the mailbox. See
     * {@link LeaseSelf.pendingNonce}; absent, this behaves exactly as it did.
     */
    pendingNonce?: string | null;
  } = {},
): Promise<number> {
  if (!hasLeaseIo(adapter)) return 0;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = opts.now ?? new Date();
  const io = adapter.leaseIo({ installId, mailboxId });
  /* A full folder must not stop a release, and the election's rule is not this one. `listClaims()`
   * refuses a folder it could not read whole, because the GATE reads an incomplete election as "nobody
   * holds this mailbox" and would start organizing one somebody else has. That refusal is right there
   * and wrong here: a teardown must not be abortable by bookkeeping. The question here is not "who holds
   * this mailbox" but "which of these are MINE", answered per-record by install id — a record this
   * window did not cover cannot be identified, but also cannot be ours in the case that matters (a claim
   * we are releasing was renewed by APPENDING, so it is at the END of the folder, inside a newest-first
   * window). Getting it wrong is not a lost claim but a DELAYED handover, on the paths where a person
   * has just said they want this install to let go. */
  /* Locate from a current read, delete the pairs that read named, confirm by re-read. `findOwnRecords`
   * was a server-side header search that a real provider refused on EVERY poll (RC3, 38 failed passes)
   * while a plain current-folder delete succeeded — so its reach was paid for with a release that could
   * be refused for ever. It is now a COMPLETE, CURRENT read under the folder's current UIDVALIDITY, the
   * selection made by the gate's own parser, and the refs handed to the delete are facts from that read
   * (`removeClaims` refuses refs from another numbering). A read that could not be complete throws
   * {@link ClaimReleaseError} and the caller logs `organizer_claim_release_failed` (the claim ages out
   * on its own). The DELETE is not the proof — the RE-READ is: `removeClaims` cannot see a record the
   * locate never named (the uid-REWRITE shape), so the confirm requires NONE of ours to remain. */
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
  /** Is this nonce one this install wrote — the acknowledged one, or one it never heard back about? */
  const named = (c: OrganizerClaim): boolean =>
    c.nonce === nonce || (opts.pendingNonce != null && c.nonce === opts.pendingNonce);
  /** OUR CLAIM, or a STRANDED record of ours — the two terms of one address. */
  const releasableIn = (messages: RawClaimMessage[]): OrganizerClaim[] =>
    ownClaimsIn(messages).filter((c) => named(c) || stale(c));
  /** A record of ours this install cannot name AND cannot age out: a LIVE sibling lineage. */
  const unnameableIn = (messages: RawClaimMessage[]): OrganizerClaim[] =>
    ownClaimsIn(messages).filter((c) => !named(c) && !stale(c));

  /* A release is addressed by (install, nonce), not by install alone. The election has always been
   * nonce-scoped, because a restored image carries our install id and a nonce we never generated — so
   * without the nonce it reads as ourselves, two organizers. The release was id-scoped, and the
   * asymmetry showed: a second profile of the same lineage had its claim deleted by a sibling's stop.
   * WITHOUT A NONCE THERE IS NO WIDER DELETE — an install that cannot name its claim refuses here, and
   * the lapse bound records the release once the claim has been un-renewed for a whole window. The
   * GATE's own expunge stays id-scoped, and that is not an inconsistency: its `ourRefs` is reused by the
   * RENEW to clear our own superseded claims (older nonces by design), so narrowing it there leaks one
   * claim per cycle — and a live sibling is caught one layer earlier by the election's clone read. */
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
  /* And it refuses only when it accomplished nothing. This threw whenever an unnameable record stood,
   * conflating two questions the rest of this file keeps apart: "did THIS install give up its claim" —
   * which the count answers, true even with a live sibling beside it — and "is the mailbox free", which
   * is the PEEK's to decide at the caller and which correctly withholds the row's stamp on any live
   * holder. Throwing over a completed release told the caller its own claim still stood. So the refusal
   * is for the case where there was nothing this install could name or age out and something of its id
   * is still being renewed: nothing happened, and saying `0` would read as "our claim was not there". */
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
 * This organizer lost the mailbox while it was writing to it. Thrown by {@link LeasePermit.check}, and
 * deliberately NOT the same class as {@link LeaseUnavailableError}: "somebody else holds this now" and
 * "I could not look" must not be reachable from one another (the rule `ORGANIZER-LEASE-RESUME.md` §3.4
 * states for the gate, held here for the re-check), because a pass that treated an unreadable lease as
 * a takeover would stand a mailbox down on a dropped connection. A pass that catches this and carries
 * on has reopened the hole the permit exists to close: every `guard`/`check` seam in this repository
 * ABORTS its pass (see `junk-sweep.ts#junkSweepPass`), so the honest stop was designed for before there
 * was anything to throw.
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
 * How long a lease read is allowed to stand for. The lease's own staleness window is ten minutes
 * ({@link DEFAULT_STALE_AFTER_MS}) — how long a claim stays fresh WITHOUT A RENEW. This is a different
 * and much shorter number, and conflating the two is the mistake: ten minutes is how long we believe
 * somebody ELSE is still there, one minute is how long we are willing to keep writing on the strength
 * of a look we already took. A minute against an IMAP move measured in tens of milliseconds amortizes
 * the re-read over a whole chunk of work rather than paying it per message, and bounds the overlap a
 * takeover can produce to one minute of writes instead of a whole pass.
 */
export const DEFAULT_PERMIT_TTL_MS = 60 * 1000;

/**
 * The shortest a permit may be — a CORRECTNESS floor, not a cost one. Two gate runs in the same
 * millisecond make an organizer stand ITSELF down: measured 2026-09-01 with `runLeaseGate` ALONE, one
 * run in three, the second answering `stand_down` against a folder holding one claim, OUR OWN, bearing
 * the nonce we passed as `lastNonce` — and a stand-down RELEASES our claims, so the folder is left
 * EMPTY. The trigger is the shared instant (a renew appends a claim whose `heartbeat` and `claimedAt`
 * equal the one it replaces, separable only by nonce), and it did not reproduce with the clock advanced
 * thirty seconds. NOTHING IN PRODUCTION reaches it, and this permit is the first caller that could run
 * the gate twice in a millisecond — the floor is here rather than an engine edit to a decision table.
 */
export const MIN_PERMIT_TTL_MS = 1000;

/**
 * Is another process wearing my install id renewing right now? — the operator CLI's own question.
 * `lastNonce: null` means "trust anything wearing my id" (a crashed worker must recognise its own claim
 * to resume, with no memory of the nonce it wrote), and `cloudInstallId()` is a STABLE literal for the
 * same reason — two correct decisions that compose into a wrong one in a one-shot tool holding no leader
 * lock: `run-junk-sweep.ts` and `run-redacted-restore.ts` claim with the live worker's id, so the CLI
 * matches its fresh claim, `renew` expunges it (two organizers), and the worker's next gate reads the
 * CLI's nonce as a clone and stands ITSELF down, leaving the folder empty. A sentinel nonce fails too
 * (engine liveness is folder-relative). So this asks directly, in ABSOLUTE time, before the gate; the residual is a check-then-act race.
 */
export async function assertNoLiveTwin(input: {
  adapter: MailboxAdapter;
  installId: string;
  now: Date;
  staleAfterMs?: number;
}): Promise<void> {
  const { adapter, installId, now } = input;
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // The read-only io, and it has to be the read-only one. This first used `leaseIo()`, the WRITE side,
  // wrong in the case these commands are most often run in: `makeLeaseIo.listClaims()` goes straight to
  // `getMailboxLock(_meta)` with no ensure — the folder is created by `ensureMetaFolder`, which the gate
  // calls and this does not — so on a mailbox nobody has ever organized it rejects before
  // `acquireLeasePermit` can create anything, and a legitimately unclaimed mailbox could not be repaired
  // by either command. `makeLeasePeekIo` does not create the folder and reports an ABSENT folder as zero
  // claims (nobody has ever organized it), the right answer. Probed structurally like `hasLeaseIo`.
  // `hasLeaseIo` is deliberately NOT also required — it checks a capability this function does not use,
  // worse than not checking, because it reports "cannot reach the folder" for one that can read it.
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

  // Wrapped, so a transport fault reaches the callers' `LeaseUnavailableError` arm and gets the
  // SENTENCE that arm prints. Not the exit code, and this said "the exit code and the sentence" until a
  // second review: both CLIs set `process.exitCode` and then rethrow, uncaught at top level, so node
  // overrides it and exits 1 — the codes those arms select (3 for a stand-down, 4 for an unreadable
  // lease) reach no operator and no script. That is older than this wrapper and not this function's to
  // fix (the repair belongs at the top of each command, honouring the status AFTER cleanup). What is
  // fixed here is the sentence: this claimed the code as well, and a comment that overstates a
  // protection is what this file has spent the day correcting. Unwrapped, a dropped connection surfaced
  // as a raw IMAP error classified as no known refusal — the one outcome §3.4 exists to prevent.
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
      // Absolute — measured from `now`, not the newest heartbeat in the folder. That is the entire
      // difference between this and the engine's own liveness, and the reason this function exists. NO
      // FORWARD CLAMP, deliberately: one was written first, mirroring `decideLease`'s
      // `Math.min(heartbeat, now + MAX_FUTURE_SKEW_MS)`, and a mutation proved it could not change an
      // outcome (`min(h, now) > now - stale` is true exactly when `h > now - stale`) — a redundant
      // guard reads as a protection somebody relies on. The engine needs its clamp because a
      // future-dated claim could wrongly WIN an election there; here the untruthful direction is already
      // safe. The cost, stated: a claim stamped in 2099 wearing this id makes this refuse for ever
      // (fail-SAFE — nothing writes), the same exposure `decideLease`'s `plausible` gate answers.
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
 * A lease read, with a deadline on it — the thing a destructive pass carries instead of a boolean.
 * Exactly one active organizer per mailbox is the invariant CLAUDE.md names load-bearing, and a pass
 * that reads the lease once and then writes for minutes is enforcing "exactly one organizer at the
 * instant this pass began" — the window a takeover lands in. So the answer carries an expiry and the
 * pass asks it at every write boundary: inside the TTL free, past it one `runLeaseGate`, which also
 * RENEWS our claim so a long pass keeps its lease fresh. THE NONCE IS CARRIED, never re-armed:
 * `LeaseSelf.lastNonce` is the clone defence's memory, and re-verifying with `lastNonce: null` would
 * tell the gate "trust anything with my id" — the case the nonce exists to catch. So the permit owns it.
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
  /**
   * How many times the folder was STAMPED — the cheap question asked at every boundary the clock
   * and the count both cleared. Test-visible beside `reads`, because the whole claim this fix
   * makes is about the gap between the two: many probes, one read.
   */
  readonly probes: number;
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
  /**
   * THE NONCE A RENEWAL MINTED AND GOT NO ANSWER ABOUT, or `null`. Named beside {@link nonce}
   * rather than folded into it because the two say different things: one claim this install wrote
   * was acknowledged and one may be standing unacknowledged, and a release has to be able to
   * address both ({@link releaseMailboxClaim}).
   */
  readonly pendingNonce: string | null;
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
  /**
   * WHAT THIS PERMIT JUST RENEWED, handed back to whoever holds the nonce.
   *
   * A re-read is a renew: it writes a new claim and expunges the one before it. The caller's own
   * `lastNonce` is then a nonce nothing in the folder carries, and its next gate reads this
   * install's own claim as a restored CLONE of itself — it stands itself down and leaves that
   * fresh claim standing. One writer owns the settled nonce, so the permit that wrote it says so
   * here. `at` is the instant of the read, for callers whose lapse bound is measured from it.
   */
  onRenew?: (renewal: { nonce: string | null; at: Date }) => void;
  /**
   * THE ROW FOLLOWS THE CLAIM — the caller's record of this becoming, with nothing awaited first.
   * `readMailboxLease` appends and verifies this install's claim, so the mailbox is already ours to
   * every reader of `ohmail/_meta`. A caller that wrote its row behind an IMAP STATUS — 83 ms, measured
   * — spent it with its own doors refusing its own requests by name, and one with no `adopt` cannot move
   * that write itself because the claim and the verify both happen in here. The baseline reading is
   * ISSUED before this hook and AWAITED after it, so it costs the row nothing. ONCE per permit, never on
   * a renewal; a hook that throws is logged rather than swallowed, since the lease is held either way.
   */
  onClaimHeld?: (held: { nonce: string | null; at: Date }) => void | Promise<void>;
}

/**
 * HAS THE PERMIT THIS PASS RODE STOOD DOWN? — the one question a post-pass write asks.
 *
 * Not the class of whatever was thrown: `fileOne`, `reconcileFlags` and `folderOpsPass` each
 * swallow everything but a fence, so a stand-down mid-cycle reaches the end of the pass as NO
 * ERROR AT ALL, and a gate reading error classes lets the pass go on to acknowledge and expunge
 * records in a mailbox somebody else now organizes. The permit's own latch is the fact, and it is
 * set before the throw that carries it. A composition holding no permit answers `false` — "not
 * asked" is not "stood down", and a reader's own writes must not be refused by this.
 */
export function leaseStoodDown(authority: OrganizerWriteAuthority): boolean {
  return "revoked" in authority && authority.revoked;
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
  delete (base as Partial<LeasePermitInput>).onRenew;
  delete (base as Partial<LeasePermitInput>).onClaimHeld;

  // The nonce this permit has written, threaded into every later read — see the docblock.
  let lastNonce: string | null = input.self.lastNonce;
  /**
   * THE NONCE A RENEWAL MINTED BUT NEVER GOT AN ANSWER ABOUT. Carried in from the caller (a
   * longer-lived memory than this receipt: the runtime's, across permits) and updated the instant
   * the gate mints one, so an append that commits and loses its response cannot leave this permit
   * unable to name what it wrote. Cleared on the read that DID answer, because from then on the
   * pending value names a superseded record and keeping it would widen what this install calls its
   * own for no reason. See {@link LeaseSelf.pendingNonce}.
   */
  let pendingNonce: string | null = input.self.pendingNonce ?? null;
  let verifiedAt: Date;
  let issuedAt: Date;
  let uidValidity: number | bigint | null = null;
  let reads = 0;
  let probes = 0;
  let writesSinceRead = 0;
  let revoked = false;

  /**
   * THE CLAIM THIS PERMIT RIDES IS A MESSAGE, AND A TAKEOVER DELETES IT. Both of this receipt's
   * bounds are its own, so a gate that expunged our claim went unnoticed until the TTL or the
   * hundredth write — two organizers across the whole handover. Every boundary the bounds clear
   * now asks the folder {@link MetaFolderStamp} instead: unchanged counters prove it still holds
   * the records the last read decided from, this install's claim among them, and anything else is
   * a reason to run the gate rather than a verdict of its own. One IO handle, taken once — a probe
   * building one per write would re-resolve the folder's path at every boundary.
   */
  const stampIo = hasLeaseIo(input.adapter)
    ? input.adapter.leaseIo({ installId: input.self.installId, mailboxId: input.mailboxId })
    : null;
  let stamp: MetaFolderStamp | null = null;
  let unstampedSaid = false;
  /**
   * THE BASELINE IS THE CLAIM'S OWN READING, AND NEVER A LATER ONE. This used to take its own STATUS
   * here, after the caller's row write: a take-over landing in that gap was baked into the baseline, so
   * every boundary read "nothing moved" while somebody else moved the folder, for a whole TTL or a
   * hundred writes. The reading comes from {@link MailboxLeaseOutcome.stamp} — the GATE's, taken in the
   * same act as the verdict that admitted the claim and proved against it by nonce — so anything later
   * is OUTSIDE the baseline, which is what makes the first write boundary probe it. SAID ONCE PER
   * PERMIT; a connection that cannot stamp keeps exactly the bound it had, named rather than silent.
   *
   * AND A LOST CUSTODY IS A STAND-DOWN HERE, not a bound to ride out. The gate discovered the takeover
   * while recording the baseline; the permit is revoked before it is ever granted and no write boundary
   * is reached, so the mailbox is left as the winner wrote it. The TTL and the write count stay what
   * they always were — a backstop behind this, never the thing that ends the overlap.
   */
  let baselineStamped = false;
  const takeBaseline = async (reading: Promise<MetaBaselineReading>): Promise<void> => {
    const custody = await reading;
    if (custody.custody === "lost") {
      revoked = true;
      throw new OrganizerStandDownError({
        organize: false,
        reason: standDownReason(custody.verdict),
        /* `held`, never derived: the only reading that loses custody is one a LIVE rival won, which
           is what {@link MetaBaselineReading} narrows the arm's verdict to. */
        state: "held",
        by: custody.verdict.by,
      });
    }
    stamp = custody.custody === "held" ? custody.stamp : null;
    baselineStamped = stamp !== null;
    if (stamp === null && !unstampedSaid) {
      unstampedSaid = true;
      input.log?.("lease_permit_unstamped", { mailboxId: input.mailboxId });
    }
  };
  /**
   * HAS THE FOLDER MOVED SINCE THE READ THIS RECEIPT CAME FROM? `false` is "it has not, or this
   * connection cannot say" — never a stand-down, which only the gate may reach.
   *
   * A stamp that ANSWERED before and cannot now is read as movement: we were proving the claim
   * still stood and can no longer prove it, so the honest act is to look properly. That costs at
   * most one extra gate run, because the read's own baseline then comes back null and every later
   * boundary falls back to the clock.
   */
  const movedSince = async (): Promise<boolean> => {
    if (stamp === null || stampIo?.stampMeta === undefined) return false;
    probes++;
    const now = await stampIo.stampMeta();
    return now === null || !sameMetaStamp(now, stamp);
  };

  /**
   * ONE BECOMING PER PERMIT. `read()` runs again at every renewal, and what a caller records here
   * is one-shot — a press spent, a role flipped — so firing it per renewal would be the "no-op
   * UPDATE every cycle" the promotion's own header refuses to pay for. See
   * {@link LeasePermitInput.onClaimHeld} for why the throw is logged rather than propagated.
   */
  let claimHeldOwed = input.onClaimHeld;
  const announceHeld = async (held: { nonce: string | null; at: Date }): Promise<void> => {
    const hook = claimHeldOwed;
    if (hook === undefined) return;
    claimHeldOwed = undefined;
    try {
      await hook(held);
    } catch (err) {
      input.log?.("lease_permit_claim_held_failed", { mailboxId: input.mailboxId, err });
    }
  };

  const read = async (): Promise<void> => {
    const at = clock();
    reads++;
    // A read that THROWS leaves every field below untouched, which is the wanted behaviour: an
    // unreadable lease is not a stand-down (both call sites exempt `LeaseUnavailableError` by
    // class), and recording it as a fresh look would serve the stale receipt for a whole new TTL
    // on the strength of a read that failed.
    const outcome = await readMailboxLease({
      ...base,
      self: { ...input.self, lastNonce, pendingNonce },
      now: at,
      onNonceMinted: (minted: string) => {
        pendingNonce = minted;
        input.onNonceMinted?.(minted);
      },
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
    /* THE ANSWER ARRIVED, so there is nothing pending. Clearing is what keeps the widening to one
       value: a pending nonce left standing would name a record this renew has just superseded. */
    pendingNonce = null;
    verifiedAt = at;
    writesSinceRead = 0;
    // THE ROW FOLLOWS THE CLAIM: the caller's record of this becoming is issued between the
    // verified claim and the probe, with nothing awaited in front of it. See
    // {@link LeasePermitInput.onClaimHeld}.
    await announceHeld({ nonce: outcome.nonce, at });
    // THE READING WAS TAKEN WITH THE CLAIM, and it is only awaited here — so the hook above still
    // has nothing awaited in front of it, and nothing that lands during it can reach the baseline.
    // See {@link MailboxLeaseOutcome.stamp} and `takeBaseline`.
    await takeBaseline(outcome.stamp);
    // The claim in the folder is now this one — see {@link LeasePermitInput.onRenew}. Last, so a
    // caller is never told about a renewal this permit has not finished recording.
    input.onRenew?.({ nonce: outcome.nonce, at });
  };

  if (input.adopt) {
    uidValidity = input.adopt.outcome.uidValidity;
    lastNonce = input.adopt.outcome.nonce;
    pendingNonce = null;
    verifiedAt = input.adopt.at;
    reads = 1;
    // An ADOPT caller decided before it called, so its hook runs at entry rather than at the
    // decision — no later than this permit's first await, which is what the invariant needs, and
    // never silently dropped, which is what a hook the adopt path ignored would be.
    await announceHeld({ nonce: input.adopt.outcome.nonce, at: input.adopt.at });
    // AND THE BASELINE IS ADOPTED TOO. Taken here it would sit a whole round trip and a row write
    // after the claim it is meant to be one reading with — the widest form of the gap, because the
    // adopted read is the caller's. It comes with the outcome instead.
    await takeBaseline(input.adopt.outcome.stamp);
  } else {
    await read();
  }
  /*
   * THE PERMIT IS GRANTED HERE, AND THE LINE IS WHERE THE ORDER IS READ FROM.
   *
   * Nothing may be written to the mailbox before this point, so a caller's own record of the
   * becoming — the row that says `organizer` — has to be in the log ahead of it. This line is what
   * lets that be MEASURED rather than argued: `phone-stop-then-start.test.ts` reads the two events'
   * positions instead of a fixture's invocation, which the baseline move put ahead of the row on
   * purpose. `stamped` and not `baselineTaken` because the hardened logger drops any field name off
   * `ALLOWED_FIELDS`, and a dropped field is a line that says nothing.
   */
  input.log?.("lease_permit_granted", { mailboxId: input.mailboxId, stamped: baselineStamped });
  issuedAt = verifiedAt!;

  return {
    get names(): PermitIdentity {
      return {
        installId: input.self.installId, mailboxId: input.mailboxId,
        uidValidity, nonce: lastNonce, pendingNonce, issuedAt,
      };
    },
    get verifiedAt(): Date { return verifiedAt; },
    get reads(): number { return reads; },
    get probes(): number { return probes; },
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
      if (stale || worked) {
        await read();
        return;
      }
      // Neither bound is anywhere near, which is exactly the window a chosen handover lands in.
      // The stamp is asked only here: a boundary that is about to re-read anyway has nothing to
      // prove, and paying for both would put a STATUS in front of every hundredth gate run.
      if (await movedSince()) await read();
    },
  };
}

/**
 * How many write boundaries a permit may cover before it is re-read — the clock's other half. The TTL
 * bounds the overlap a takeover can produce IN TIME; it does not bound it in WRITES, and those are the
 * units the person loses: a batch pass can file several hundred messages inside one minute, so a purely
 * time-based permit lets a whole chunk of somebody else's mailbox move on one look. This is the second
 * trigger, and either alone is insufficient. 100 rather than 1: the re-read is an IMAP round trip that
 * also RENEWS, and asking per message would cost more round trips than the filing — at a budget of 500
 * per cycle it is five extra reads for a whole pass.
 */
export const PERMIT_WRITES_PER_RECHECK = 100;

/**
 * May a destructive IMAP write be issued right now? — the ONE predicate every write site asks. Two
 * questions, asked in this order and never merged: LEADERSHIP first (worker-to-worker: does this
 * process still lead its shard?) because a re-read of the lease RENEWS our claim, which is itself a
 * write a fenced worker must not make; then the LEASE (install-to-install: does this install still
 * hold the mailbox?). A census over both organizing roots asserts that every destructive verb there is
 * preceded by this call and that there is exactly one definition of it, so a new write site cannot
 * arrive without an author placing it.
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
