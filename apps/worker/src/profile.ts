import { and, desc, eq } from "drizzle-orm";
import {
  PROFILE_FOUND_AUDIT_ACTION, auditLog, latestProfileFoundMarker, profileImportResolutionExists,
  type Tx,
} from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import {
  PROFILE_VERSION, ProfileUnavailableError, isEmptyProfilePayload, makeProfileDoc, profileFingerprint,
  readOrganizerProfile, writeOrganizerProfile,
  type OrganizerProfileDoc, type OrganizerProfilePayload, type ProfileIo, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";

/**
 * THE WORKER'S HALF OF THE PORTABLE ORGANIZER PROFILE — composition, and nothing else.
 *
 * `packages/core/src/adapters/organizer-profile.ts` is the engine: the document format, the
 * read/write dance, the IO. This module supplies what the engine deliberately does not have —
 * WHERE the configuration lives (the organizer's own store) and WHEN to write (after a cycle the
 * lease gate admitted, debounced) — and it is shared by every organizer the same way `lease.ts`
 * is: the hosted worker, the desktop sidecar and a self-hosted server all run THIS composition,
 * which is what makes the document each of them writes byte-comparable with the others'.
 *
 * ── ONLY THE ACTIVE ORGANIZER WRITES, AND THAT IS INHERITED, NOT RE-DERIVED ────────────────
 *
 * {@link OrganizerProfileSync.onOrganize} is called from exactly one place in each host: the
 * point in the sync cycle that is only reachable after `readMailboxLease` answered `organize`.
 * A stood-down install never reaches it, so it never reads and never writes — the lease gate at
 * the top of every cycle is the single-writer mechanism, and a second lease check here would be
 * a second reading of one decision table, which is the divergence the lease composition exists
 * to forbid.
 *
 * ── WRITE-BEHIND, DEBOUNCED BY THE CYCLE ITSELF ────────────────────────────────────────────
 *
 * Configuration changes land in the store as they happen; this module notices them by
 * fingerprint at the NEXT admitted cycle, at most once per {@link DEFAULT_PROFILE_FLUSH_INTERVAL_MS}.
 * A burst of screener verdicts between two flushes is therefore ONE append, and there is never
 * more than one write in flight per mailbox — the per-mailbox cycle is serial in both hosts, and
 * `inFlight` makes that assumption checkable rather than assumed.
 */

/** How often the store is re-serialized and compared, at most. Tests inject smaller values. */
export const DEFAULT_PROFILE_FLUSH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How often {@link OrganizerProfileSync.importDecisionOpenNow} re-reads the folder BEFORE the
 * seed — the takeover window, where a document can land late in the permitted overlap. Short
 * enough that a late-landing document holds the gate within one ordinary poll; long enough that
 * a hot backlog drain's back-to-back cycles collapse onto one read (round 18's cost bound).
 */
export const EVAL_TAKEOVER_TTL_MS = 30 * 1000;

/**
 * The `audit_log.action` under which a found FOREIGN profile is recorded — the durable marker
 * the confirm-import flow reads. Written by the organizer at read-on-takeover; consumed by the
 * import surface. `audit_log` because it is the one generic, account-scoped marker table both
 * journals already carry (the `ohbox_tidy_move` precedent), and this feature may not add schema.
 *
 * The constant itself lives in `@trafficflow/db` now (`organizer-profile-import.ts`), because
 * the import surface's half runs in the services package and a package cannot import an app —
 * re-exported here so this module's callers and tests keep their one name for it. (The package
 * is deliberately not written out: the worker's dependency-boundary test refuses its name
 * anywhere under src/, comments included, and that bluntness is the guard's value.)
 */
export { PROFILE_FOUND_AUDIT_ACTION };

/**
 * An adapter that can hand out the profile's IO — `lease.ts`'s structural probe, for its
 * reasons: `MailboxAdapter` does not carry one feature's IMAP verbs, and the worker must not
 * widen an interface every other call site sees.
 *
 * Unlike the lease, ABSENCE IS NOT A FAULT: an adapter without `profileIo` is a mailbox whose
 * settings simply do not travel (nothing about organizing safety hinges on this document), so
 * the probe's `false` is acted on by doing nothing rather than by throwing.
 */
export interface ProfileCapableAdapter {
  profileIo(): ProfileIo;
}

/** Does this adapter expose the profile's IO? */
export function hasProfileIo(adapter: MailboxAdapter): adapter is MailboxAdapter & ProfileCapableAdapter {
  return typeof (adapter as Partial<ProfileCapableAdapter>).profileIo === "function";
}

/**
 * THE SERIALIZER — the organizer's store, read into the document's payload. It moved to
 * `@trafficflow/core/adapters/organizer-profile-store` when the import surface became its
 * second caller (the "is this found document already what the local store says" comparison
 * must be the same serialization as this dirty check, and the service layer may not import an
 * application). Re-exported so this composition's callers and tests keep their one name for it.
 */
export { serializeOrganizerProfile };

export interface OrganizerProfileSyncDeps {
  db: Tx;
  accountId: string;
  mailboxId: string;
  adapter: MailboxAdapter;
  /** The organizer's lease identity — the same values `LeaseSelf` carries. */
  self: { installId: string; kind: string };
  /** The running build's label, recorded as `producer.version`. Provenance, never a decision. */
  producerVersion: string;
  flushIntervalMs?: number;
  now?: () => Date;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/**
 * ONE MAILBOX'S PROFILE STATE, for the life of one attachment — created beside the runtime the
 * way the known-set memo is, and dropped with it, so a mailbox that changes hands starts cold
 * and re-reads what the folder actually holds.
 *
 * ── READ-ON-TAKEOVER, AND THE RULE THAT KEEPS IT FROM DESTROYING THE THING IT FOUND ────────
 *
 * The first admitted cycle READS the folder before anything is written. What it finds decides
 * whether write-behind may run at all:
 *
 *  · `none` / `unreadable` — nothing to preserve. Write-behind runs; an EMPTY local
 *    configuration still writes nothing (a mailbox that has said nothing gets no document).
 *  · `found`, and it is OURS (the message's install id is this organizer's) — our own previous
 *    write, possibly stale if configuration changed while the process was down. The found
 *    fingerprint seeds the dirty check, so a difference is flushed on this very cycle.
 *  · `found`, FOREIGN, and CONTENT-IDENTICAL to local state — already in sync (the ordinary
 *    hand-back between two installs that share a history). Write-behind resumes.
 *  · `found`, FOREIGN, and DIFFERENT — **the import case, and the write-behind HOLDS.** The
 *    document is somebody's configuration that this organizer has not been told to adopt, and
 *    the import decision belongs to a human (the confirm flow), never to this module. The fact
 *    is surfaced twice: a log line, and a durable `audit_log` marker the confirm flow reads.
 *    The hold releases only on the user's answer, which reaches this module two ways: by
 *    CONVERGENCE — local state comes to equal the document, which is what an import applied
 *    into an empty store produces — or by the durable RESOLUTION marker the confirm flow
 *    writes (`organizer_profile_import_resolved`), which covers the two answers convergence
 *    cannot see: an import merged into existing local configuration, and a decline. Until one
 *    of those, this organizer writes nothing, so the found document survives exactly as long
 *    as the decision is open.
 *  · `newer` — written by a later format. Never overwritten (the engine refuses too, but this
 *    module does not even try); surfaced the same two ways.
 */
export class OrganizerProfileSync {
  private seeded = false;
  private blockedByNewer = false;
  /** The found FOREIGN document's fingerprint — the hold. Null when no import decision is open. */
  private holdFingerprint: string | null = null;
  /**
   * The OTHER hold subject: a document written by a NEWER format. Its open
   * question is "update ohmail, or dismiss and organize with what you have" — and while that is
   * unanswered the same routing hold applies, because a v(n+1) document carries decisions this
   * build cannot read but knows exist: routing a takeover from a cold store past them is the
   * TAKEOVER-RESCREEN defect with a version bump. Released through the existing `newerV`
   * resolution rows. Mutually exclusive with {@link holdFingerprint}. Distinct from
   * {@link blockedByNewer}, which is the WRITE posture and never releases on an answer — this
   * build can never overwrite fields it cannot represent, dismissed or not.
   */
  private holdNewerV: number | null = null;
  /**
   * When the hold began. Informational only (release is by the EXACT subject
   * only — the since-valve it once fed released a re-armed hold on a stale answer to the
   * document it replaced); kept because "how long has this question been open" is the first
   * thing a debugging session asks.
   */
  private holdSince: Date | null = null;
  private lastWrittenFingerprint: string | null = null;
  /**
   * Foreign documents discovered and SURFACED (recorded durably) — the next write may supersede
   * them. A SET, not a slot: the folder can hold two distinct foreign documents at once (crash
   * residue from another install's own append-then-expunge dance), and a single slot would let
   * each refusal evict the other document's fingerprint — the write oscillating between two
   * surfacings and never landing. The asymmetry with {@link holdFingerprint} is principled: at SEED we
   * may be a NEW organizer meeting configuration that travelled here (an open import decision,
   * so we hold); mid-flight we are the ESTABLISHED organizer and a document that appears under
   * us is the loser of a transient overlap — last-incumbent-wins says our store is the mailbox's
   * truth, and the engine's `foreign` refusal guarantees we surfaced it before superseding it.
   */
  private seenForeignFingerprints = new Set<string>();
  /** A detection marker that could not be written durably yet — owed, and retried next tick. */
  private markerPending: MarkerFact | null = null;
  private lastAttemptAt = 0;
  /** When the preflight last completed a read — the seeded never-owned re-probe's clock. */
  private lastPreflightAt = 0;
  private inFlight = false;

  constructor(private readonly deps: OrganizerProfileSyncDeps) {}

  /**
   * FORGET EVERYTHING THIS PROCESS BELIEVED ABOUT OWNING THIS MAILBOX'S DOCUMENT.
   *
   * Called when the lease demotes this install to a reader, and it exists because mail 0083 made
   * the runtime OUTLIVE the role. Before it, a demotion detached: the `OrganizerProfileSync`
   * object went with the runtime, and a later promotion built a new one that had never seen the
   * mailbox. A demoted runtime is now kept and re-promoted in place, so without this the second
   * organizing life starts holding the FIRST one's beliefs.
   *
   * Two of them are actively wrong after a handover, and they compound:
   *
   *  · `seeded` + `lastWrittenFingerprint` make {@link armHoldFromFolder} return at its second
   *    guard, so the promotion's preflight probes nothing;
   *  · and `lastWrittenFingerprint` makes the evaluator classify the document the OTHER organizer
   *    wrote while it held the mailbox as an established incumbent's mid-flight residue — the one
   *    case it deliberately does not hold on. The re-promoted install would route on its own
   *    stale rules and then supersede the inherited document instead of offering it for import,
   *    which is the takeover re-screen this whole hold exists to prevent, reached by a longer
   *    road.
   *
   * `seenForeignFingerprints` goes for the same reason: those surfacings belong to the previous
   * life. The durable half — the marker rows — is untouched and is what a re-derivation reads.
   * Nothing here writes to the mailbox or to the database; it is one process's memory being told
   * that it is no longer this mailbox's organizer.
   */
  forgetOrganizerLife(): void {
    this.seeded = false;
    this.lastWrittenFingerprint = null;
    this.seenForeignFingerprints = new Set<string>();
    this.holdFingerprint = null;
    this.holdNewerV = null;
    this.holdSince = null;
    this.blockedByNewer = false;
    this.evalCache = null;
    this.lastPreflightAt = 0;
    this.lastOpenAnswer = false;
    this.everEvaluated = false;
  }

  /**
   * Whether a found FOREIGN document's import decision is open for this mailbox — the routing
   * half of the hold. `runSyncCycle` reads this once per cycle and threads it to `planChange` as
   * {@link PlanDeps.importDecisionOpen}, which is what stops the consent gate re-screening mail
   * whose senders the travelling document already answers (TAKEOVER-RESCREEN). The write-behind
   * half of the same hold is the `holdFingerprint` machinery in {@link onOrganize}.
   */
  importDecisionOpen(): boolean {
    return this.holdFingerprint !== null || this.holdNewerV !== null;
  }

  /**
   * Whether the previous {@link importDecisionOpenNow} evaluation answered "open" — served when
   * an evaluation faults, so one bad read costs one stale-answer cycle instead of a flip.
   */
  private lastOpenAnswer = false;
  /** Whether {@link importDecisionOpenNow} has ever completed an evaluation — see its catch. */
  private everEvaluated = false;
  /** The folder verdict the evaluator last read, and when — see the cost note on the evaluator. */
  private evalCache: {
    at: number;
    verdict: { kind: "closed" } | { kind: "found"; fingerprint: string } | { kind: "newer"; v: number };
  } | null = null;

  /**
   * ══ THE STRUCTURAL ANSWER TO "IS AN IMPORT DECISION OPEN?" — EVALUATED, NEVER CHOREOGRAPHED ══
   *
   * Everything here circles one mechanism: an in-memory hold trying to TRACK a question
   * whose truth lives in three places that all move independently — the folder (the previous
   * organizer can write, a hand can expunge, a newer build can pass through), the account store
   * (a sibling mailbox's import converges it), and the resolutions table (any tab can answer).
   * Every arm/release ordering had a mirror-image race, because a cached distributed fact always
   * does — the known-set memo's header states the same law for UIDs.
   *
   * So ROUTING evaluates the question instead:
   *
   *   found, foreign, never-owned-by-us, ≠ local store, unanswered → open  (the takeover hold)
   *   newer format, undismissed                                    → open  (unreadable decisions)
   *   anything else — including a foreign document under an organizer that already OWNS this
   *   mailbox's configuration (`lastWrittenFingerprint`), which is the permitted overlap's loser
   *   writing late and is superseded, never held (round 16)        → closed
   *
   * ── WHAT IS RE-READ WHEN, AND WHY THAT IS BOUNDED (round 18) ────────────────────────────────
   *
   * `readOrganizerProfile` fetches the document's full source, so an unconditional per-cycle
   * read would re-download an unbounded document once per batch — a backlog drain re-fetching
   * the same profile hundreds of times, the exact over-fetch family the Sent-scan fix in this
   * slice exists to kill. The FOLDER verdict is therefore cached and re-read on a clock:
   *
   *   · UNSEEDED (the takeover window, bounded to the first drain): every
   *     {@link EVAL_TAKEOVER_TTL_MS} — hot back-to-back drain cycles collapse onto one read,
   *     and a document landing in the permitted overlap's window is seen within the TTL, the
   *     same one-step bound every accepted residual in this family carries.
   *   · SEEDED (the incumbent steady state): every flush interval — the cadence this module's
   *     own verify pass has always read the folder at, so the steady-state IMAP cost is
   *     unchanged from before this slice.
   *
   * The DATABASE side — the answer and the convergence, which can change with no folder motion —
   * is read on EVERY call while the cached verdict is a question, releasing at the cycle edge.
   * While the verdict is closed, a call between folder reads costs nothing at all.
   *
   * NEVER THROWS: a faulted evaluation answers the ARMED write-side hold when one is known
   * (round 17 — stronger evidence than any fallback), else what the previous evaluation
   * answered. The write-side hold machinery is no longer load-bearing for where a message
   * lands; it remains the write-behind's overwrite gate and the durable marker's writer.
   */
  async importDecisionOpenNow(): Promise<boolean> {
    const { deps } = this;
    const log = deps.log ?? ((): void => undefined);
    if (!hasProfileIo(deps.adapter)) return false;
    try {
      const now = (deps.now ?? ((): Date => new Date()))().getTime();
      // A CLOSED verdict cached before a hold was armed is stale by construction (round 19):
      // the seed or the preflight read the folder more recently than this cache did. One
      // comparison, no site enumeration — whoever arms, the next evaluation re-reads.
      if (this.evalCache?.verdict.kind === "closed"
        && (this.holdFingerprint !== null || this.holdNewerV !== null)) {
        this.evalCache = null;
      }
      const ttl = this.seeded
        ? (deps.flushIntervalMs ?? DEFAULT_PROFILE_FLUSH_INTERVAL_MS)
        : Math.min(EVAL_TAKEOVER_TTL_MS, deps.flushIntervalMs ?? EVAL_TAKEOVER_TTL_MS);
      if (this.evalCache === null || now - this.evalCache.at >= ttl) {
        const read: ProfileReadResult = await readOrganizerProfile(deps.adapter.profileIo());
        // A fresh read that shows the newer-format document GONE drops the write wall its
        // presence raised (round 18): the wall's referent vanished, and holding it would keep
        // the write-behind — and the held-marker surfacing a replacement document needs — off
        // for the life of the attachment.
        if (read.state !== "newer" && this.blockedByNewer) this.blockedByNewer = false;
        let verdict: NonNullable<OrganizerProfileSync["evalCache"]>["verdict"] = { kind: "closed" };
        if (read.state === "newer") {
          verdict = { kind: "newer", v: read.v };
        } else if (read.state === "found" && read.installId !== deps.self.installId) {
          // An ESTABLISHED incumbent does not hold on mid-flight residue (round 16): once this
          // organizer OWNS a document (`lastWrittenFingerprint` — its own write, an own/in-sync
          // seed, or a convergence release), a differing foreign document is the overlap's
          // loser writing late — surfaced and superseded, never held.
          const fp = profileFingerprint(read.doc);
          // …and neither does one this organizer has already SURFACED for supersede
          // (`seenForeignFingerprints` — the verify pass reopens the dirty check by clearing
          // `lastWrittenFingerprint`, so ownership alone cannot tell "never owned" from
          // "mid-supersede"): holding it would freeze the heal it is queued for.
          if (!(this.lastWrittenFingerprint !== null && fp !== this.lastWrittenFingerprint)
            && !this.seenForeignFingerprints.has(fp)) {
            verdict = { kind: "found", fingerprint: fp };
          }
        }
        this.evalCache = { at: now, verdict };
      }
      const v = this.evalCache.verdict;
      let open = false;
      if (v.kind === "newer") {
        open = !(await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, newerV: v.v,
        }));
      } else if (v.kind === "found") {
        const localFp = profileFingerprint(await serializeOrganizerProfile(deps.db, deps.accountId));
        open = v.fingerprint !== localFp && !(await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, fingerprint: v.fingerprint,
        }));
      }
      this.lastOpenAnswer = open;
      this.everEvaluated = true;
      return open;
    } catch {
      // Before the FIRST successful evaluation, a KNOWN armed hold outranks the (never
      // computed) answer (round 17): the preflight may have armed the write-side hold before
      // this evaluation's own reads ever succeeded, and answering "closed" from a blank
      // fallback while a question is provably open is the takeover re-screen again. Once an
      // evaluation HAS succeeded, its answer is fresher than the write-side hold — which
      // releases on its own debounced cadence and may lag a dismissal by a flush interval.
      if (!this.everEvaluated) {
        return this.holdFingerprint !== null || this.holdNewerV !== null || this.lastOpenAnswer;
      }
      return this.lastOpenAnswer;
    }
  }

  /**
   * THE CYCLE-EDGE READ OF THE HOLD — releases a hold the user has already ANSWERED before the
   * next routing decision is made. {@link importDecisionOpen} alone is the write-behind's view,
   * and the write-behind is DEBOUNCED (five minutes by default): a release that waited for the
   * next flush tick would keep adopting strangers' mail as `last_set_by: 'external'` for a whole
   * write interval after the person decided. One indexed read per cycle,
   * only while a decision is open. A read fault keeps the hold — the answer could not be read,
   * the next cycle retries, and holding is the reversible direction: an adopted message can
   * still be screened by the person; a screened message was already the defect.
   */
  async importDecisionOpenFresh(): Promise<boolean> {
    if (this.holdFingerprint === null && this.holdNewerV === null) return false;
    const { deps } = this;
    const log = deps.log ?? ((): void => undefined);
    try {
      // THE EXACT SUBJECT ONLY. A mailbox-wide "any answer since the hold
      // began" valve used to ride along here, from the era when a hold never re-armed: now that
      // `reholdFromFolder` tracks the folder, a STALE answer — a tab declining document A after
      // the folder moved on to B — must not release B's hold. The valve's one legitimate case
      // (the surface answered the folder's CURRENT document while this hold still keys the old
      // one) is covered by the rehold itself: its replacement check refuses an already-answered
      // document, so the swap lands as a lapse and the gate resumes within a flush interval.
      const answered = await profileImportResolutionExists(deps.db, {
        accountId: deps.accountId, mailboxId: deps.mailboxId,
        ...(this.holdFingerprint !== null
          ? { fingerprint: this.holdFingerprint }
          : { newerV: this.holdNewerV! }),
      });
      if (answered) {
        // RE-DERIVE before the gate resumes (rounds 7 and 8): the folder may already ask a NEW
        // question — the previous organizer's late flush replacing the answered document — and
        // an answer to A is not an answer to B. Every fallible read runs BEFORE the release
        // commits, so a fault leaves the answered hold standing (retried next cycle) rather
        // than stranding the mailbox released with B's question open and nothing re-deriving.
        let next: Awaited<ReturnType<OrganizerProfileSync["deriveNextHold"]>> = { kind: "lapse" };
        if (hasProfileIo(deps.adapter)) {
          const still = await readOrganizerProfile(deps.adapter.profileIo());
          const localFp = profileFingerprint(await serializeOrganizerProfile(deps.db, deps.accountId));
          next = await this.deriveNextHold(still, localFp);
        }
        // Nothing below throws. The answered subject is released and the folder's current
        // question (or clean lapse) committed in one motion.
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "resolved",
        });
        await this.commitNextHold(next, log);
      } else if (this.holdFingerprint !== null) {
        const localFp = profileFingerprint(await serializeOrganizerProfile(deps.db, deps.accountId));
        if (localFp === this.holdFingerprint) {
          // CONVERGENCE: the store is ACCOUNT-scoped, so the same travelling
          // profile imported through a SIBLING mailbox — or a hand-edit — can make local state
          // equal the held document with no resolution row for THIS mailbox. The candidate is
          // gone from the confirm surface the moment they match, so the hold must not outlive
          // the comparison by a debounce interval.
          //
          // Round 8: the folder is re-read BEFORE the release commits, exactly like the
          // answered arm above — the held document may have been REPLACED since (local
          // converged onto A, the folder moved to B), and a convergence release that never
          // looked would lose B deterministically. When the folder still holds the converged
          // document, it is released as the debounced convergence arm releases it: it becomes
          // our own last-written baseline and NOTHING is rewritten — putting it on
          // `seenForeignFingerprints` instead would have the next tick supersede a
          // byte-equivalent document just to change its author.
          let next: Awaited<ReturnType<OrganizerProfileSync["deriveNextHold"]>> | null = null;
          let stillConverged = true;
          if (hasProfileIo(deps.adapter)) {
            const still = await readOrganizerProfile(deps.adapter.profileIo());
            stillConverged = still.state === "found" && profileFingerprint(still.doc) === this.holdFingerprint;
            if (!stillConverged) next = await this.deriveNextHold(still, localFp);
          }
          if (stillConverged) {
            const converged = this.holdFingerprint;
            this.lastWrittenFingerprint = converged;
            this.holdFingerprint = null;
            this.holdSince = null;
            // The DURABLE half too: the in-memory release alone leaves the
            // held marker standing for ever — `latestProfileFoundMarker` reading a held question and the
            // candidate surface dialing IMAP for a question nothing asks. The lapse names the
            // converged subject, closing exactly it.
            await this.writeMarker({ state: "lapsed", fingerprint: converged, v: null }, log);
          } else {
            await this.commitNextHold(next!, log);
          }
        }
      }
    } catch {
      // The hold stands; the next cycle retries. Deliberately silent: this runs on every cycle
      // while a decision is open, and the debounced tick's own failure arm already reports a
      // database that keeps refusing.
    }
    return this.holdFingerprint !== null || this.holdNewerV !== null;
  }

  /**
   * ARM THE HOLD BEFORE THE FIRST ORGANIZE — called from `attach()`, before any routing cycle.
   *
   * The seed inside {@link onOrganize} discovers a travelling document too, but it runs at the
   * END of a completed cycle — and the drill measured exactly what that ordering costs: the first
   * cycles of a takeover ingested and MOVED the mailbox's screened-in history into the Screener
   * while the document answering for those senders was one FETCH away. This is the narrow,
   * read-only slice of the seed that the ROUTING needs early: read the folder, and when what it
   * holds is a foreign, different, not-yet-answered document, arm the hold and write the durable
   * marker the confirm surface reads. Nothing is written to the mailbox, `seeded` stays false
   * (the full seed still runs on the first tick and re-derives everything from the folder), and
   * every other state — none, unreadable, newer, ours, in-sync — is left for the seed to handle.
   *
   * Never throws. A failure here leaves the hold UNARMED and is logged: the residual is ordinary
   * routing until the first tick's seed retries, which is the pre-fix behaviour for at most one
   * cycle — against holding the gate closed for every mailbox whose `ohmail/_meta` read hiccuped,
   * the bounded residual is the right side.
   */
  async armHoldFromFolder(): Promise<void> {
    const { deps } = this;
    const log = deps.log ?? ((): void => undefined);
    if (!hasProfileIo(deps.adapter)) return;
    // NO completed-read memo here, deliberately (an earlier one was removed): the organizer
    // lease permits a ONE-CYCLE overlap, so the outgoing organizer's last admitted cycle can
    // append the travelling document AFTER an early preflight honestly read `none` — and a
    // memoized "nothing there" would hide it for the sidecar's whole first drain. Until the
    // seed runs, every call re-probes: one folder read per pre-seed cycle, dying at the seed —
    // EXCEPT for a seeded organizer that has never OWNED this mailbox's document (round 18):
    // for that one, the write path is unreachable while its store is empty and the seed is
    // spent, so this preflight is the only writer of the held marker an open question needs to
    // be ANSWERABLE. Its caller there runs at the flush cadence (`onOrganize`'s empty-store
    // return), never per cycle.
    if (this.holdFingerprint !== null || this.holdNewerV !== null) return;
    if (this.seeded && this.lastWrittenFingerprint !== null) return;
    // The seeded never-owned re-probe runs at the FLUSH cadence (round 19): the sidecar enters
    // a drain every poll (seconds), and an empty-store install would otherwise re-download an
    // answered document four times a minute for ever. Pre-seed stays per-call — that window is
    // the first drain, and the probe dies at the seed.
    if (this.seeded) {
      const nowMs = (deps.now ?? ((): Date => new Date()))().getTime();
      if (nowMs - this.lastPreflightAt < (deps.flushIntervalMs ?? DEFAULT_PROFILE_FLUSH_INTERVAL_MS)) return;
      this.lastPreflightAt = nowMs;
    }
    try {
      const io = deps.adapter.profileIo();
      const read: ProfileReadResult = await readOrganizerProfile(io);
      // A NEWER format's document is an open question too — "update ohmail, or organize with
      // what you have" — and until it is answered (the `newerV` resolution the dismiss writes),
      // routing a takeover past decisions this build cannot read is the same defect (round 2).
      if (read.state === "newer") {
        if (await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, newerV: read.v,
        })) return;
        this.holdNewerV = read.v;
        this.holdSince = (deps.now ?? ((): Date => new Date()))();
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "newer",
        });
        await this.writeMarker({ state: "newer", v: read.v }, log);
        return;
      }
      if (read.state !== "found") { await this.lapseStaleMarker(read, null, log); return; }
      const fp = profileFingerprint(read.doc);
      if (read.installId === deps.self.installId) { await this.lapseStaleMarker(read, null, log); return; }
      // A document already SURFACED for supersede is the incumbent's to replace, not a question
      // — the verify pass reopens the dirty check by clearing `lastWrittenFingerprint`, so
      // ownership alone cannot tell "never owned" from "mid-supersede".
      if (this.seenForeignFingerprints.has(fp)) return;
      const payload = await serializeOrganizerProfile(deps.db, deps.accountId);
      if (fp === profileFingerprint(payload)) { await this.lapseStaleMarker(read, profileFingerprint(payload), log); return; }
      // Already answered (an earlier hold on this same document, resolved by import or decline):
      // a re-attach must not re-open a question the person closed.
      if (await profileImportResolutionExists(deps.db, {
        accountId: deps.accountId, mailboxId: deps.mailboxId, fingerprint: fp,
      })) return;
      this.holdFingerprint = fp;
      this.holdSince = (deps.now ?? ((): Date => new Date()))();
      log("organizer_profile_detected", {
        mailboxId: deps.mailboxId, accountId: deps.accountId, state: "found",
      });
      await this.writeMarker({ state: "found", doc: read.doc, fingerprint: fp, heldForImport: true }, log);
    } catch (err) {
      log("organizer_profile_write_failed", {
        mailboxId: deps.mailboxId, accountId: deps.accountId,
        ...(err instanceof ProfileUnavailableError ? { op: err.op } : {}),
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A HELD QUESTION THE FOLDER NO LONGER ASKS — re-derive the hold from what stands there NOW.
   *
   * Called from the hold blocks when the durable answer has not arrived: the folder can change
   * while the question is open (the previous organizer writes again, a hand-expunge, a newer
   * build passing through), and the confirm surface reads the FOLDER — so the hold must track
   * the folder or the two disagree about whether a question is open (a held
   * document REPLACED by another foreign one cleared the hold while the surface kept offering
   * the replacement, and screening resumed under an open prompt). Three outcomes:
   *
   *  · the folder still asks the HELD question — the hold stands untouched;
   *  · it asks a DIFFERENT one (another foreign-different unanswered document, or a newer
   *    format) — the hold is RE-ARMED on the new subject and the marker written, because the
   *    question changed rather than closed;
   *  · it asks NOTHING (gone, ours, in-sync, corrupt, or already answered) — the hold lapses
   *    (`hold_lapsed`), and the next tick takes the ordinary arms for what stands there.
   *
   * One folder read per flush interval, only while a decision is open. A read FAULT throws into
   * the caller's catch and the hold stands — the reversible direction.
   */
  private async reholdFromFolder(
    io: ProfileIo,
    localFingerprint: string,
    log: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<"standing" | "lapsed"> {
    const still: ProfileReadResult = await readOrganizerProfile(io);
    if (still.state === "found" && this.holdFingerprint !== null
      && profileFingerprint(still.doc) === this.holdFingerprint) return "standing";
    if (still.state === "newer" && this.holdNewerV !== null && still.v === this.holdNewerV) return "standing";
    // Decide the NEXT posture while the OLD hold is still armed: every read in the derivation
    // can throw, and a throw must leave the standing hold standing (a swap that
    // cleared first left the gate open for a debounce interval when the replacement's resolution
    // read faulted). The caller's catch retries next tick either way.
    const next = await this.deriveNextHold(still, localFingerprint);
    await this.commitNextHold(next, log);
    return next.kind === "lapse" ? "lapsed" : "standing";
  }

  /**
   * The DECISION half of a hold swap — PURE READS, no state change, so a caller can run it while
   * a hold it is about to release still stands (every release site must
   * decide the folder's next posture BEFORE clearing, or a fault mid-derivation strands the
   * mailbox with no hold and no retry).
   */
  private async deriveNextHold(
    still: ProfileReadResult,
    localFingerprint: string,
  ): Promise<
    | { kind: "found"; fingerprint: string; doc: OrganizerProfileDoc }
    | { kind: "newer"; v: number }
    | { kind: "lapse" }
  > {
    const { deps } = this;
    if (still.state === "found" && still.installId !== deps.self.installId) {
      const newFp = profileFingerprint(still.doc);
      if (newFp !== localFingerprint && !(await profileImportResolutionExists(deps.db, {
        accountId: deps.accountId, mailboxId: deps.mailboxId, fingerprint: newFp,
      }))) {
        return { kind: "found", fingerprint: newFp, doc: still.doc };
      }
    } else if (still.state === "newer" && !(await profileImportResolutionExists(deps.db, {
      accountId: deps.accountId, mailboxId: deps.mailboxId, newerV: still.v,
    }))) {
      return { kind: "newer", v: still.v };
    }
    return { kind: "lapse" };
  }

  /**
   * The COMMIT half — swaps the hold onto `next` and writes the durable marker. Nothing here
   * throws (`writeMarker` self-catches into the owed-marker retry), so a caller that has already
   * released its old subject cannot be stranded half-swapped.
   */
  private async commitNextHold(
    next: Awaited<ReturnType<OrganizerProfileSync["deriveNextHold"]>>,
    log: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const { deps } = this;
    // The released found subject moves to `seenForeignFingerprints` so a later write may
    // supersede its residue — and the lapse below NAMES it, so a stale lapse can never close a
    // question it did not hold (round 12).
    const releasedFingerprint = this.holdFingerprint;
    const releasedNewerV = this.holdNewerV;
    if (this.holdFingerprint !== null) this.seenForeignFingerprints.add(this.holdFingerprint);
    this.holdFingerprint = null;
    this.holdNewerV = null;
    this.holdSince = null;
    if (next.kind === "found") {
      this.holdFingerprint = next.fingerprint;
      this.holdSince = (deps.now ?? ((): Date => new Date()))();
      log("organizer_profile_detected", {
        mailboxId: deps.mailboxId, accountId: deps.accountId, state: "found",
      });
      await this.writeMarker({ state: "found", doc: next.doc, fingerprint: next.fingerprint, heldForImport: true }, log);
      return;
    }
    if (next.kind === "newer") {
      this.holdNewerV = next.v;
      this.holdSince = (deps.now ?? ((): Date => new Date()))();
      log("organizer_profile_detected", {
        mailboxId: deps.mailboxId, accountId: deps.accountId, state: "newer",
      });
      await this.writeMarker({ state: "newer", v: next.v }, log);
      return;
    }
    log("organizer_profile_detected", {
      mailboxId: deps.mailboxId, accountId: deps.accountId, state: "hold_lapsed",
    });
    // THE DURABLE HALF OF THE LAPSE: the reconcile backstop reads the hold from
    // the latest marker + the resolution rows, and a lapse that lived only in this process would
    // leave the backstop adopting for ever on a question nothing asks — the import surface has
    // no candidate to answer. A `lapsed` marker reads as "no open question" to both — for the
    // subject it names and no other.
    await this.writeMarker({ state: "lapsed", fingerprint: releasedFingerprint, v: releasedNewerV }, log);
  }

  /**
   * A DURABLE HELD MARKER WHOSE QUESTION THE FOLDER NO LONGER ASKS — written `lapsed`, so the
   * confirm surface's durable read (`latestProfileFoundMarker`) agrees with
   * reality ACROSS PROCESS DEATHS: a worker that armed and marked a hold, then died before any
   * rehold tick, must not leave the backstop adopting for ever on a question nothing asks.
   * Called from the preflight and the seed's non-arming arms — the arms that
   * looked at the folder and found no question to hold; an ANSWERED marker needs no lapse (its
   * resolution row already closes the predicate). One indexed read per call, at attach cadence.
   */
  private async lapseStaleMarker(
    read: ProfileReadResult,
    localFingerprint: string | null,
    log: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const { deps } = this;
    const marker = await latestProfileFoundMarker(deps.db, deps.accountId, deps.mailboxId);
    if (!marker) return;
    if (marker.state === "found" && !marker.heldForImport) return; // midflight markers hold nothing
    // A found marker still asks only while the folder holds THAT document AND it is a question:
    // foreign, and different from local state — a document ours or converged-onto has nothing
    // left to import, whatever the marker says.
    const stillAsks =
      (marker.state === "found" && read.state === "found" && marker.fingerprint !== null
        && profileFingerprint(read.doc) === marker.fingerprint
        && read.installId !== deps.self.installId
        && (localFingerprint === null || profileFingerprint(read.doc) !== localFingerprint))
      || (marker.state === "newer" && read.state === "newer" && read.v === marker.v);
    if (!stillAsks) {
      await this.writeMarker({
        state: "lapsed",
        fingerprint: marker.state === "found" ? marker.fingerprint : null,
        v: marker.state === "newer" ? (marker.v ?? null) : null,
      }, log);
    }
  }

  /**
   * The write-behind tick. Called ONLY from a cycle the lease gate admitted; never throws —
   * a profile fault must not count against a mailbox whose provider did nothing wrong.
   */
  async onOrganize(): Promise<void> {
    const { deps } = this;
    const log = deps.log ?? ((): void => undefined);
    if (this.inFlight) return;
    if (!hasProfileIo(deps.adapter)) return;
    const now = (deps.now ?? ((): Date => new Date()))();
    const interval = deps.flushIntervalMs ?? DEFAULT_PROFILE_FLUSH_INTERVAL_MS;
    if (this.seeded && now.getTime() - this.lastAttemptAt < interval) return;
    this.inFlight = true;
    try {
      this.lastAttemptAt = now.getTime();
      const io = deps.adapter.profileIo();
      const payload = await serializeOrganizerProfile(deps.db, deps.accountId);
      const fp = profileFingerprint(payload);

      // A detection marker that failed durably is owed, not forgotten: the hold or the newer
      // block it belongs to stays in force, so the fact it records must eventually be readable
      // by the confirm flow — a transient database blip must not orphan a detection.
      // BEFORE the seed, so a marker that failed inside this very tick's seed waits for the
      // NEXT tick rather than being re-attempted milliseconds after the database refused it.
      if (this.markerPending !== null) {
        const pending = this.markerPending;
        this.markerPending = null;
        await this.writeMarker(pending, log);
        // STILL OWED AFTER THE RETRY ⇒ THIS TICK WRITES NOTHING. The pending fact may be a
        // foreign document whose fingerprint is already on `seenForeignFingerprint`, and the
        // write path below would supersede — expunge — that document with its durable record
        // still unwritten. "Content only ever leaves the folder after the incumbent has
        // recorded that it saw it" is the engine's guarantee, and a marker the database keeps
        // refusing must not be the loophole; the read-only work below is equally deferrable.
        if (this.markerPending !== null) return;
      }

      if (!this.seeded) {
        await this.seed(io, fp, log);
        this.seeded = true;
      }

      // ── THE NEWER-FORMAT HOLD'S RELEASE VALVES — before the `blockedByNewer` wall ─────────
      //
      // `blockedByNewer` returns for the life of the process (this build can never write over
      // fields it cannot represent), so a routing hold keyed to a newer document must run its
      // release checks BEFORE that return or they never run at all: the user's dismiss releases
      // it, and `reholdFromFolder` tracks a folder whose question changed or vanished. The
      // answer settles the ROUTING question only — the write posture deliberately stands.
      if (this.holdNewerV !== null) {
        // The exact subject only — see the same rule in `importDecisionOpenFresh` (round 6).
        const resolvedNewer = await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, newerV: this.holdNewerV,
        });
        if (resolvedNewer) {
          // RE-DERIVE even on the answered release (rounds 7 and 8) — with extra force here,
          // because the `blockedByNewer` wall below makes this block the LAST code that ever
          // reads the folder: a readable document that replaced the dismissed newer one between
          // two ticks would otherwise never be seen at all. Derivation reads run BEFORE the
          // release commits, so a fault leaves the answered hold standing for the next tick.
          const stillNewer = await readOrganizerProfile(io);
          const nextNewer = await this.deriveNextHold(stillNewer, fp);
          log("organizer_profile_detected", {
            mailboxId: deps.mailboxId, accountId: deps.accountId, state: "resolved",
          });
          await this.commitNextHold(nextNewer, log);
        } else {
          await this.reholdFromFolder(io, fp, log);
        }
        return;
      }
      if (this.holdFingerprint !== null) {
        if (fp === this.holdFingerprint) {
          // Local state converged onto the found document (the import was applied, exactly):
          // the hold is over, and there is nothing to write — the document already says this.
          // The folder is re-read BEFORE the release commits (the same rule as
          // the cycle-edge convergence arm): the held document may have been REPLACED since —
          // local converged onto A, the folder moved on to unanswered B — and a release that
          // never looked would leave B to surface later as an unheld mid-flight document.
          const stillConverged = await (async (): Promise<boolean> => {
            const still = await readOrganizerProfile(io);
            if (still.state === "found" && profileFingerprint(still.doc) === this.holdFingerprint) return true;
            const next = await this.deriveNextHold(still, fp);
            await this.commitNextHold(next, log);
            return false;
          })();
          if (!stillConverged) return;
          this.holdFingerprint = null;
          this.holdNewerV = null;
          this.holdSince = null;
          this.lastWrittenFingerprint = fp;
          // The durable half, as at the cycle edge (round 14): the held marker must not outlive
          // the question.
          await this.writeMarker({ state: "lapsed", fingerprint: fp, v: null }, log);
          return;
        }
        // ── THE OTHER RELEASE: THE USER ANSWERED, AND THE ANSWER DID NOT EQUAL THE DOCUMENT ──
        //
        // Convergence alone cannot end two legitimate outcomes of the confirm flow: an import
        // MERGED into existing local configuration (local ⊃ document, so the fingerprints never
        // meet), and a DECLINE (keep local). Both are recorded durably by the import surface —
        // `organizer_profile_import_resolved`, keyed to the held document's fingerprint — and
        // either one means the local store is the user-ratified truth for this mailbox. The
        // hold releases; the held fingerprint moves to `seenForeignFingerprint` so the next
        // write may supersede the document THROUGH the engine's foreign gate (it was surfaced,
        // and now answered); the dirty check is already open (nothing was written since seed).
        // One indexed read per flush interval, only while a decision is open — and the EXACT
        // held fingerprint only. The "any answer since the hold began" valve
        // that used to ride here belonged to the era when a hold never re-armed: the confirm
        // surface answers the folder's CURRENT document, and `reholdFromFolder` below now moves
        // this hold onto exactly that document — its replacement check refuses one that is
        // already answered, so a hold keyed to an older fingerprint converges through the
        // rehold, while a STALE answer to a superseded document can no longer release a
        // question that is still open.
        const resolved = await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, fingerprint: this.holdFingerprint,
        });
        if (!resolved) {
          // Still unanswered — but only a question the folder still ASKS may keep holding. The
          // hold now also defers the consent gate (`PlanDeps.importDecisionOpen`), so a hold
          // whose document was expunged or replaced would otherwise track a question the
          // confirm surface is not offering — in either direction (see `reholdFromFolder`).
          await this.reholdFromFolder(io, fp, log);
          // …and RETURN, writing nothing either way: a standing or re-armed hold forbids the
          // write, and after a lapse the next tick reads the folder fresh and takes the
          // ordinary arms for whatever now stands there.
          return;
        }
        // RE-DERIVE before the gate resumes (rounds 7 and 8): an answer to the held document
        // is not an answer to one that replaced it mid-window — and the derivation's reads run
        // BEFORE the release commits, so a fault leaves the answered hold standing for the next
        // tick instead of stranding the mailbox released with the replacement unheld.
        const still = await readOrganizerProfile(io);
        const next = await this.deriveNextHold(still, fp);
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "resolved",
        });
        await this.commitNextHold(next, log);
        // …and RETURN, writing nothing on this tick. The payload above was serialized BEFORE
        // the answer was read, so a write here could ship a snapshot from before an import that
        // committed in between — superseding the confirmed document with pre-import state. The
        // NEXT tick serializes the store as the answer left it and resumes write-behind on that.
        return;
      }
      // AFTER both hold blocks, deliberately: `reholdFromFolder` can swap a
      // newer-format hold for a found one when the folder's document changes shape, and a
      // fingerprint hold walled off behind this return would never run its own release or
      // re-derivation again — held for ever once its document vanished, with nothing for the
      // confirm surface to answer. The write posture this guards is untouched: every arm of the
      // hold blocks above returns without writing.
      if (this.blockedByNewer) return;
      if (fp === this.lastWrittenFingerprint) {
        // Nothing to write — but LOOK once per interval anyway. This is what heals the residue
        // of a transient organizer overlap (two documents from two writers, neither of which
        // will ever change its store again) and what notices a document appearing
        // under an established organizer without any local change.
        await this.verifyFolder(io, fp, log);
        return;
      }
      // A mailbox that has said nothing gets no document: writing an empty payload into a fresh
      // mailbox would be litter, and its absence already means defaults. An empty payload IS
      // written when a document exists (lastWrittenFingerprint non-null) — clearing your last
      // rule is configuration too. BUT LOOK before returning (round 18): this return is the one
      // path that reaches neither the verify pass nor the write path, so for a never-owned
      // organizer it must carry the held-marker surfacing a late-landing travelling document
      // needs — or the routing hold the evaluator computes would be a question no surface could
      // ever offer for answering. Flush cadence, self-guarded.
      if (this.lastWrittenFingerprint === null && isEmptyProfilePayload(payload)) {
        await this.armHoldFromFolder();
        return;
      }

      const doc = makeProfileDoc(payload, {
        updatedAt: now,
        producer: { kind: deps.self.kind, version: deps.producerVersion },
      });
      const result = await writeOrganizerProfile({
        io, doc, installId: deps.self.installId,
        // What this writer may replace: its own last write, and any foreign document it has
        // already SURFACED. Anything else refuses as `foreign` below — the engine's guarantee
        // that no foreign configuration is ever expunged before it was recorded.
        replaceable: [
          ...(this.lastWrittenFingerprint === null ? [] : [this.lastWrittenFingerprint]),
          ...this.seenForeignFingerprints,
        ],
        log: (event, detail) => { log(event, { ...detail, mailboxId: deps.mailboxId, accountId: deps.accountId }); },
      });
      if (result.written) {
        this.lastWrittenFingerprint = fp;
        this.seenForeignFingerprints.clear();
        log("organizer_profile_written", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, pruned: result.removed,
        });
      } else if (result.reason === "newer") {
        // A newer document arrived between the seed and this write. Same posture as at seed —
        // including the durable marker, which the log line alone is not: the confirm flow
        // reads the database, never the process's stderr.
        this.blockedByNewer = true;
        // …and the ROUTING hold too: the wall below makes this the last look
        // this attachment ever takes at the folder, so a newer document that landed mid-write
        // and armed nothing would have mail re-screened under an unanswered update-or-dismiss
        // prompt for the attachment's whole life. ARM-THEN-VERIFY (round 11): a fault in the
        // dismissal read must leave the hold armed, never the wall up with routing unheld.
        this.holdNewerV = result.v;
        this.holdSince = now;
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "newer",
        });
        // Marker before the fallible verify — see the seed's newer arm (round 19).
        await this.writeMarker({ state: "newer", v: result.v }, log);
        if (await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, newerV: result.v,
        })) {
          this.holdNewerV = null;
          this.holdSince = null;
        }
      } else {
        // A foreign document appeared under an established organizer (the transient overlap's
        // loser, or a hand-back mid-race). The INCUMBENT posture surfaces it — log + durable
        // marker, never held for import: last-incumbent-wins says our store is this mailbox's
        // truth — and records its fingerprint so the NEXT write may supersede it. If the lease
        // changes hands before then, we never write again and the document stands: convergent
        // both ways.
        const foreignFp = profileFingerprint(result.doc);
        this.seenForeignFingerprints.add(foreignFp);
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "found_midflight",
        });
        await this.writeMarker({
          state: "found", doc: result.doc, fingerprint: foreignFp, heldForImport: false,
        }, log);
      }
    } catch (err) {
      // One failure arm for the whole tick, and the event names the feature rather than the
      // step: `err` reduces to class + code in `log.ts`, and `ProfileUnavailableError.op` names
      // the step when there is one.
      log("organizer_profile_write_failed", {
        mailboxId: deps.mailboxId, accountId: deps.accountId,
        ...(err instanceof ProfileUnavailableError ? { op: err.op } : {}),
        err: err instanceof Error ? err.message : String(err),
      });
      // A seed that threw is retried by the next tick; nothing was marked seeded.
    } finally {
      this.inFlight = false;
    }
  }

  /** The read-on-takeover. Throws only through `onOrganize`'s catch, which retries next tick. */
  private async seed(
    io: ProfileIo,
    localFingerprint: string,
    log: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const { deps } = this;
    const read: ProfileReadResult = await readOrganizerProfile(io);
    // The preflight (`armHoldFromFolder`) may have armed a hold on a document this read no
    // longer sees — expunged, replaced, or converged-onto in the window between attach and the
    // first tick. The seed is the authoritative reading, so each arm below SUPERSEDES the
    // provisional hold with what the folder actually asks (a hold with no
    // document behind it would suppress screening and write-behind for ever, with nothing for
    // the confirm surface to answer) — and each arm clears it only AFTER its own fallible reads
    // have answered (a clear ahead of a read that then throws strands the
    // mailbox unheld until the retry, with `armed` already remembering a preflight that DID
    // complete).
    const clearProvisionalHold = (): void => {
      this.holdFingerprint = null;
      this.holdNewerV = null;
      this.holdSince = null;
    };
    const detected = (state: string): void => {
      log("organizer_profile_detected", { mailboxId: deps.mailboxId, accountId: deps.accountId, state });
    };
    switch (read.state) {
      case "none":
        clearProvisionalHold();
        detected("none");
        await this.lapseStaleMarker(read, null, log);
        return;
      case "unreadable":
        // Nothing recoverable in a corrupt copy of our own bookkeeping; the next flush replaces it.
        clearProvisionalHold();
        detected("unreadable");
        await this.lapseStaleMarker(read, null, log);
        return;
      case "newer": {
        this.blockedByNewer = true;
        // The routing hold too (round 2): the mailbox travels with decisions this build cannot
        // read; until the user answers the update-or-dismiss question, the gate adopts placement
        // rather than re-screening past them. ARM-THEN-VERIFY (round 11): the wall this arm
        // raises is permanent, so the hold must exist before any fallible read — a fault after
        // `blockedByNewer` with the hold unarmed would leave this attachment screening past an
        // unanswered question with nothing ever retrying. An already-dismissed version is
        // released by the verify; a fault leaves the hold armed, the reversible direction
        // (`importDecisionOpenFresh` re-checks the resolution every cycle).
        clearProvisionalHold();
        this.holdNewerV = read.v;
        this.holdSince = (this.deps.now ?? ((): Date => new Date()))();
        detected("newer");
        // The marker BEFORE the verify (round 19): it states the found fact, true whatever the
        // answer says, and `writeMarker` never throws (a refused write is owed and retried) —
        // while a verify that faults would exit the tick with the marker never attempted and
        // the standing-question ticks never retrying it.
        await this.writeMarker({ state: "newer", v: read.v }, log);
        if (await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, newerV: read.v,
        })) {
          this.holdNewerV = null;
          this.holdSince = null;
        }
        return;
      }
      case "found": {
        const docFingerprint = profileFingerprint(read.doc);
        const ours = read.installId === deps.self.installId;
        if (ours || docFingerprint === localFingerprint) {
          // Our own previous write (stale or not), or a foreign one that says exactly what we
          // would say: seed the dirty check from it and let write-behind do its ordinary work.
          // A foreign-but-identical document is ours to replace on the next change — record it,
          // or the engine's foreign refusal would deadlock the first post-convergence write.
          clearProvisionalHold();
          this.lastWrittenFingerprint = docFingerprint;
          if (!ours) this.seenForeignFingerprints.add(docFingerprint);
          detected(ours ? "found_own" : "found_in_sync");
          await this.lapseStaleMarker(read, localFingerprint, log);
          return;
        }
        clearProvisionalHold();
        this.holdFingerprint = docFingerprint;
        this.holdNewerV = null;
        this.holdSince = (this.deps.now ?? ((): Date => new Date()))();
        detected("found");
        await this.writeMarker({ state: "found", doc: read.doc, fingerprint: docFingerprint, heldForImport: true }, log);
        return;
      }
    }
  }

  /**
   * The durable half of the surfacing — one `audit_log` row per DISTINCT found document, which
   * is what the confirm-import flow reads. Deduplicated on the document's fingerprint so a
   * worker that re-attaches every deploy does not accumulate one marker per restart.
   */
  /**
   * ONCE PER INTERVAL, WHEN THERE IS NOTHING TO WRITE: read what the folder actually holds.
   *
   * The fingerprint comparison alone cannot see two failure shapes, both from the same transient
   * overlap the lease permits for one cycle: (a) TWO documents left by two writers, neither of
   * whose stores will ever change again — nothing dirty, so nothing ever expunges the loser's
   * copy, and a later reader may coalesce onto it; (b) a foreign document that OVERWROTE ours
   * with no local change to trigger a write. Both heal here: force the dirty check open
   * (`lastWrittenFingerprint = null`) after recording what was seen, and the next tick's write
   * supersedes — through the engine's foreign gate, so nothing is expunged unsurfaced.
   */
  private async verifyFolder(
    io: ProfileIo,
    localFingerprint: string,
    log: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const { deps } = this;
    const read: ProfileReadResult = await readOrganizerProfile(io);
    switch (read.state) {
      case "none":
        // Deleted by hand. The message's own preamble promises a fresh copy when settings next
        // CHANGE — so the dirty check stays closed and nothing is rewritten now.
        return;
      case "unreadable":
        // A corrupt copy of bookkeeping carries nothing recoverable; replace it on the next tick.
        this.lastWrittenFingerprint = null;
        return;
      case "newer":
        this.blockedByNewer = true;
        // The routing hold rides along, exactly as on the write path's `newer` arm one function
        // up (round 8): the wall this flag raises would otherwise outlive the only look that
        // saw the newer document. ARM-THEN-VERIFY (round 11), as at the other two newer sites.
        this.holdNewerV = read.v;
        this.holdSince = (deps.now ?? ((): Date => new Date()))();
        log("organizer_profile_detected", { mailboxId: deps.mailboxId, accountId: deps.accountId, state: "newer" });
        // Marker before the fallible verify — see the seed's newer arm (round 19).
        await this.writeMarker({ state: "newer", v: read.v }, log);
        if (await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, newerV: read.v,
        })) {
          this.holdNewerV = null;
          this.holdSince = null;
        }
        return;
      case "found": {
        const docFingerprint = profileFingerprint(read.doc);
        const ours = read.installId === deps.self.installId;
        if (docFingerprint === localFingerprint) {
          // The current document says what we say. A residue copy beside it is the overlap's
          // leftover — reopen the dirty check so the next tick rewrites and expunges it.
          if (read.residue > 0) this.lastWrittenFingerprint = null;
          return;
        }
        if (ours) {
          // Our own write that our memory does not match (another process sharing our install
          // id, or memory lost to a code path we did not foresee): trust the store, rewrite.
          this.lastWrittenFingerprint = docFingerprint;
          return;
        }
        // A differing foreign document under an established organizer — surface, record, and
        // let the next write supersede it. The same posture as the write path's `foreign` arm.
        this.seenForeignFingerprints.add(docFingerprint);
        this.lastWrittenFingerprint = null;
        log("organizer_profile_detected", { mailboxId: deps.mailboxId, accountId: deps.accountId, state: "found_midflight" });
        await this.writeMarker({ state: "found", doc: read.doc, fingerprint: docFingerprint, heldForImport: false }, log);
        return;
      }
    }
  }

  private async writeMarker(
    fact: MarkerFact,
    log: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const { deps } = this;
    try {
      const fingerprint = fact.state === "found" ? fact.fingerprint
        : fact.state === "lapsed" ? (fact.fingerprint ?? null) : null;
      const heldForImport = fact.state === "found" ? fact.heldForImport : false;
      const [latest] = await deps.db.select({ payload: auditLog.payload })
        .from(auditLog)
        .where(and(eq(auditLog.accountId, deps.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      const prior = latest?.payload as {
        mailboxId?: string; fingerprint?: string | null; state?: string; heldForImport?: boolean;
        v?: number;
      } | null | undefined;
      // The version is part of a `newer` fact's identity: a dismissed v2 marker must not
      // swallow the detection of a v3 — each later format is a NEW fact the confirm surface
      // has not answered.
      const v = fact.state === "newer" ? fact.v : fact.state === "lapsed" ? (fact.v ?? null) : null;
      if (prior && prior.mailboxId === deps.mailboxId && prior.state === fact.state
        && (prior.fingerprint ?? null) === fingerprint && (prior.heldForImport ?? false) === heldForImport
        && (prior.v ?? null) === v) {
        // The current fact is ALREADY durable — deduplicated, not skipped — so any older fact
        // still owed from a failed write is stale here too: retried later it
        // would file AFTER this one and become the "latest" marker over the question the folder
        // actually asks. EXCEPT when the landing fact is a LAPSE (round 14): a lapse closes the
        // subject it names only through a held marker that EXISTS, so an owed `found`/`newer`
        // fact must survive the lapse landing and file above it — dropping it would leave the
        // reader walking past the lapse onto an older unmatched question and reporting it open.
        if (fact.state !== "lapsed") this.markerPending = null;
        return;
      }
      await deps.db.insert(auditLog).values({
        accountId: deps.accountId,
        action: PROFILE_FOUND_AUDIT_ACTION,
        payload: fact.state === "found"
          ? {
            mailboxId: deps.mailboxId, state: fact.state, fingerprint, heldForImport,
            updatedAt: fact.doc.updatedAt, producer: fact.doc.producer,
            counts: {
              screener: fact.doc.screener.length,
              rules: fact.doc.rules.length,
              notifyRules: fact.doc.notifyRules.length,
              tagNames: fact.doc.tagNames.length,
              awayResponder: fact.doc.awayResponder === null ? 0 : 1,
            },
          }
          : { mailboxId: deps.mailboxId, state: fact.state, fingerprint, heldForImport, v },
        inverse: null,
      });
      // A marker that LANDED supersedes any older fact still owed from a failed write (review
      // round 9): retrying the stale one later would file it AFTER this row and make it the
      // "latest" marker — an answered or replaced question resurrected over the current one,
      // which the confirm surface and the backstop predicate both read newest-first. A LAPSE
      // landing is the one exception (round 14) — see the dedup arm above.
      if (fact.state !== "lapsed") this.markerPending = null;
    } catch (err) {
      // The log line beside the detection already carries the fact for an operator; the DURABLE
      // record is owed to the confirm flow, so it is kept pending and retried next tick rather
      // than forgotten — and it must never abort a sync to get itself written.
      this.markerPending = fact;
      log("organizer_profile_marker_failed", {
        mailboxId: deps.mailboxId, accountId: deps.accountId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** A detection the confirm flow must be able to read durably. See {@link OrganizerProfileSync.writeMarker}. */
type MarkerFact =
  | { state: "found"; doc: OrganizerProfileDoc; fingerprint: string; heldForImport: boolean }
  | { state: "newer"; v: number }
  /**
   * A held question the folder no longer asks — see `commitNextHold` and `lapseStaleMarker`.
   * NAMES THE SUBJECT IT LAPSES: a reader honours a lapse only against the
   * held marker it names, so a stale process's lapse — derived from a folder snapshot that
   * predates a successor's newly-armed question — cannot hide that question. `fingerprint` for
   * a found subject, `v` for a newer one; `latestProfileFoundMarker` implements the reading.
   */
  | { state: "lapsed"; fingerprint?: string | null; v?: number | null };

export { PROFILE_VERSION };
export type { OrganizerProfileDoc, OrganizerProfilePayload };
