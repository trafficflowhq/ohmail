import { and, desc, eq } from "drizzle-orm";
import {
  auditLog, awayResponders, contacts, notifyRules as notifyRulesTbl, rules as rulesTbl, tags as tagsTbl,
  type Tx,
} from "@trafficflow/db";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
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
 * the confirm-import flow reads. Written by the organizer at read-on-takeover; consumed (later)
 * by the import surface. `audit_log` because it is the one generic, account-scoped marker table
 * both journals already carry (the `ohbox_tidy_move` precedent), and this slice may not add
 * schema.
 */
export const PROFILE_FOUND_AUDIT_ACTION = "organizer_profile_found";

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
 * THE SERIALIZER — the organizer's store, read into the document's payload.
 *
 * It reads ONLY configuration: the screened-in senders (`contacts` — a row there IS the
 * screener's "yes"; the "no" is durably a rule whose destination is `ohmail/Screened`, so it
 * travels in `rules`), the rules by their natural keys, the notification opt-ins, the single
 * autoresponder row, and the tag names. Deliberately NOT read: anything adaptive (rule hit
 * counts, retro-apply state, learning signals) and anything secret — there is no credential
 * column in any query below, and the suite pins the serialized document's exact key census so a
 * new field is a reviewed decision.
 */
export async function serializeOrganizerProfile(db: Tx, accountId: string): Promise<OrganizerProfilePayload> {
  // ONE SNAPSHOT, not five. Under READ COMMITTED each statement sees its own snapshot, so a
  // screener decide committing between the contacts read and the rules read would serialize a
  // TORN configuration — the contact without its promoted rule — and the document would say
  // something no store ever held (self-healing one flush later, but "a burst is one write" is
  // the contract, and a torn read is how it becomes two). REPEATABLE READ pins all five reads
  // to one snapshot; PGlite is real Postgres, so the same statement works on both stores.
  const [contactRows, ruleRows, notifyRows, awayRows, tagRows] = await db.transaction(async (tx) => {
    return [
      await tx.select({ address: contacts.address, name: contacts.name })
        .from(contacts).where(eq(contacts.accountId, accountId)),
      await tx.select({
        kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination,
        priority: rulesTbl.priority, enabled: rulesTbl.enabled, provenance: rulesTbl.provenance,
        subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
      }).from(rulesTbl).where(eq(rulesTbl.accountId, accountId)),
      await tx.select({ kind: notifyRulesTbl.kind, target: notifyRulesTbl.target })
        .from(notifyRulesTbl).where(eq(notifyRulesTbl.accountId, accountId)),
      await tx.select({
        enabled: awayResponders.enabled, subject: awayResponders.subject, body: awayResponders.body,
        startsAt: awayResponders.startsAt, endsAt: awayResponders.endsAt, audience: awayResponders.audience,
      }).from(awayResponders).where(eq(awayResponders.accountId, accountId)),
      await tx.select({ name: tagsTbl.name }).from(tagsTbl).where(eq(tagsTbl.accountId, accountId)),
    ] as const;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const away = awayRows[0];
  return {
    screener: contactRows.map((c) => (c.name === null ? { address: c.address } : { address: c.address, name: c.name })),
    rules: ruleRows.map((r) => ({
      kind: r.kind, match: r.match, destination: r.destination,
      priority: r.priority, enabled: r.enabled, provenance: r.provenance,
      ...(r.subjectContains === null ? {} : { subjectContains: r.subjectContains }),
      ...(r.bodyContains === null ? {} : { bodyContains: r.bodyContains }),
    })),
    notifyRules: notifyRows.map((n) => ({ kind: n.kind, target: n.target })),
    awayResponder: away === undefined ? null : {
      enabled: away.enabled,
      subject: away.subject,
      body: away.body,
      startsAt: away.startsAt === null ? null : away.startsAt.toISOString(),
      endsAt: away.endsAt === null ? null : away.endsAt.toISOString(),
      audience: away.audience,
    },
    tagNames: tagRows.map((t) => t.name),
  };
}

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
 *    The hold releases by CONVERGENCE only — when local state comes to equal the document
 *    (the import was applied), write-behind resumes; until then this organizer writes nothing,
 *    so the found document survives exactly as long as the decision is open.
 *  · `newer` — written by a later format. Never overwritten (the engine refuses too, but this
 *    module does not even try); surfaced the same two ways.
 */
export class OrganizerProfileSync {
  private seeded = false;
  private blockedByNewer = false;
  /** The found FOREIGN document's fingerprint — the hold. Null when no import decision is open. */
  private holdFingerprint: string | null = null;
  private lastWrittenFingerprint: string | null = null;
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

      if (!this.seeded) {
        await this.seed(io, fp, log);
        this.seeded = true;
      }

      if (this.blockedByNewer) return;
      if (this.holdFingerprint !== null) {
        if (fp !== this.holdFingerprint) return; // the import decision is still open — write nothing
        // Local state converged onto the found document (the import was applied): the hold is over.
        this.holdFingerprint = null;
        this.lastWrittenFingerprint = fp;
        return;
      }
      if (fp === this.lastWrittenFingerprint) return;
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
        log: (event, detail) => { log(event, { ...detail, mailboxId: deps.mailboxId, accountId: deps.accountId }); },
      });
      if (result.written) {
        this.lastWrittenFingerprint = fp;
        log("organizer_profile_written", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, pruned: result.removed,
        });
      } else {
        // A newer document arrived between the seed and this write. Same posture as at seed.
        this.blockedByNewer = true;
        log("organizer_profile_detected", {
          mailboxId: deps.mailboxId, accountId: deps.accountId, state: "newer",
        });
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
        const docPayload: OrganizerProfilePayload = {
          screener: read.doc.screener, rules: read.doc.rules, notifyRules: read.doc.notifyRules,
          awayResponder: read.doc.awayResponder, tagNames: read.doc.tagNames,
        };
        const docFingerprint = profileFingerprint(docPayload);
        const ours = read.installId === deps.self.installId;
        if (ours || docFingerprint === localFingerprint) {
          // Our own previous write (stale or not), or a foreign one that says exactly what we
          // would say: seed the dirty check from it and let write-behind do its ordinary work.
          this.lastWrittenFingerprint = docFingerprint;
          detected(ours ? "found_own" : "found_in_sync");
          return;
        }
        this.holdFingerprint = docFingerprint;
        detected("found");
        await this.writeMarker({ state: "found", doc: read.doc, fingerprint: docFingerprint }, log);
        return;
      }
    }
  }

  /**
   * The durable half of the surfacing — one `audit_log` row per DISTINCT found document, which
   * is what the confirm-import flow reads. Deduplicated on the document's fingerprint so a
   * worker that re-attaches every deploy does not accumulate one marker per restart.
   */
  private async writeMarker(
    found: { state: "found"; doc: OrganizerProfileDoc; fingerprint: string } | { state: "newer"; v: number },
    log: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<void> {
    const { deps } = this;
    try {
      const fingerprint = found.state === "found" ? found.fingerprint : null;
      const [latest] = await deps.db.select({ payload: auditLog.payload })
        .from(auditLog)
        .where(and(eq(auditLog.accountId, deps.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)))
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      const prior = latest?.payload as { mailboxId?: string; fingerprint?: string | null; state?: string } | null | undefined;
      if (prior && prior.mailboxId === deps.mailboxId && prior.state === found.state
        && (prior.fingerprint ?? null) === fingerprint) {
        return;
      }
      await deps.db.insert(auditLog).values({
        accountId: deps.accountId,
        action: PROFILE_FOUND_AUDIT_ACTION,
        payload: found.state === "found"
          ? {
            mailboxId: deps.mailboxId, state: found.state, fingerprint,
            updatedAt: found.doc.updatedAt, producer: found.doc.producer,
            counts: {
              screener: found.doc.screener.length,
              rules: found.doc.rules.length,
              notifyRules: found.doc.notifyRules.length,
              tagNames: found.doc.tagNames.length,
              awayResponder: found.doc.awayResponder === null ? 0 : 1,
            },
          }
          : { mailboxId: deps.mailboxId, state: found.state, fingerprint, v: found.v },
        inverse: null,
      });
    } catch (err) {
      // The log line above already carries the fact; a marker that could abort the seed would
      // turn bookkeeping into a sync fault.
      log("organizer_profile_marker_failed", {
        mailboxId: deps.mailboxId, accountId: deps.accountId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export { PROFILE_VERSION };
export type { OrganizerProfileDoc, OrganizerProfilePayload };
