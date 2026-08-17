import { and, desc, eq } from "drizzle-orm";
import {
  PROFILE_FOUND_AUDIT_ACTION, auditLog, profileImportResolutionExists, profileImportResolutionSince,
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
  /** When the hold began — the floor for "was the mailbox's import question answered since". */
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
  private inFlight = false;

  constructor(private readonly deps: OrganizerProfileSyncDeps) {}

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

      if (this.blockedByNewer) return;
      if (this.holdFingerprint !== null) {
        if (fp === this.holdFingerprint) {
          // Local state converged onto the found document (the import was applied, exactly):
          // the hold is over, and there is nothing to write — the document already says this.
          this.holdFingerprint = null;
          this.lastWrittenFingerprint = fp;
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
        // One indexed read per flush interval, only while a decision is open. TWO shapes of
        // answer count, because the folder can change while the question is open: the exact
        // held fingerprint was answered, or ANY answer for this mailbox landed after the hold
        // began — the confirm surface reads the folder, not this hold, so it answers the
        // CURRENT document, and a hold keyed to the older one must not stay frozen until a
        // process restart when the person has already decided.
        const resolved = await profileImportResolutionExists(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, fingerprint: this.holdFingerprint,
        }) || (this.holdSince !== null && await profileImportResolutionSince(deps.db, {
          accountId: deps.accountId, mailboxId: deps.mailboxId, since: this.holdSince,
        }));
        if (!resolved) return; // the import decision is still open — write nothing
        this.seenForeignFingerprints.add(this.holdFingerprint);
        this.holdFingerprint = null;
        this.holdSince = null;
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "resolved",
        });
        // …and RETURN, writing nothing on this tick. The payload above was serialized BEFORE
        // the answer was read, so a write here could ship a snapshot from before an import that
        // committed in between — superseding the confirmed document with pre-import state. The
        // NEXT tick serializes the store as the answer left it and resumes write-behind on that.
        return;
      }
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
      // rule is configuration too.
      if (this.lastWrittenFingerprint === null && isEmptyProfilePayload(payload)) return;

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
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "newer",
        });
        await this.writeMarker({ state: "newer", v: result.v }, log);
      } else {
        // A foreign document appeared under an established organizer (the transient overlap's
        // loser, or a hand-back mid-race). Surface it — log + durable marker, never
        // held for import: last-incumbent-wins says our store is this mailbox's truth — and
        // record its fingerprint so the NEXT write may supersede it. If the lease changes hands
        // before then, we never write again and the document stands: convergent both ways.
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
    const detected = (state: string): void => {
      log("organizer_profile_detected", { mailboxId: deps.mailboxId, accountId: deps.accountId, state });
    };
    switch (read.state) {
      case "none":
        detected("none");
        return;
      case "unreadable":
        // Nothing recoverable in a corrupt copy of our own bookkeeping; the next flush replaces it.
        detected("unreadable");
        return;
      case "newer":
        this.blockedByNewer = true;
        detected("newer");
        await this.writeMarker({ state: "newer", v: read.v }, log);
        return;
      case "found": {
        const docFingerprint = profileFingerprint(read.doc);
        const ours = read.installId === deps.self.installId;
        if (ours || docFingerprint === localFingerprint) {
          // Our own previous write (stale or not), or a foreign one that says exactly what we
          // would say: seed the dirty check from it and let write-behind do its ordinary work.
          // A foreign-but-identical document is ours to replace on the next change — record it,
          // or the engine's foreign refusal would deadlock the first post-convergence write.
          this.lastWrittenFingerprint = docFingerprint;
          if (!ours) this.seenForeignFingerprints.add(docFingerprint);
          detected(ours ? "found_own" : "found_in_sync");
          return;
        }
        this.holdFingerprint = docFingerprint;
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
        log("organizer_profile_detected", { mailboxId: deps.mailboxId, accountId: deps.accountId, state: "newer" });
        await this.writeMarker({ state: "newer", v: read.v }, log);
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
      const fingerprint = fact.state === "found" ? fact.fingerprint : null;
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
      const v = fact.state === "newer" ? fact.v : null;
      if (prior && prior.mailboxId === deps.mailboxId && prior.state === fact.state
        && (prior.fingerprint ?? null) === fingerprint && (prior.heldForImport ?? false) === heldForImport
        && (prior.v ?? null) === v) {
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
          : { mailboxId: deps.mailboxId, state: fact.state, fingerprint, heldForImport, v: fact.v },
        inverse: null,
      });
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
  | { state: "newer"; v: number };

export { PROFILE_VERSION };
export type { OrganizerProfileDoc, OrganizerProfilePayload };
