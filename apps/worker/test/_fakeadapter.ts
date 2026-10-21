import { MessageGoneError, ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import type {
  MailboxAdapter, ImapConfig, ImapCursor, ChangeBatch, ImapCapabilities,
  OutboundMessage, SendResult, FetchedPart, FetchByUidOptions, TargetedFetch,
} from "@trafficflow/core/adapters/imap";
import type {
  LeaseIo, LeasePeekIo, MetaFolderStamp, RawClaimMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo, RawProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import type { Change, MimeStructure, NativeLocator } from "@trafficflow/core";
import { assertMetaIdentity } from "@trafficflow/core/adapters/organizer-lease";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * A controllable in-memory MailboxAdapter, injected through `WorkerConfig.adapterFactory`.
 *
 * Real greenmail proves the happy path but cannot produce the failures that actually matter
 * here: a POST-connect failure (does the worker close the connection it already opened, or
 * leak the login?), a mailbox that starts failing at RUNTIME after a clean attach, total sync
 * death (is /health honest about it?), or a connect that BLOCKS on a barrier so a stop() can
 * be landed exactly mid-takeover. Every one of those is a one-line flag here.
 *
 * It also counts connects/closes, which is how the connection-leak assertions bite.
 */
export interface FakeControl {
  failConnect?: boolean;
  failEnsureFolders?: boolean;
  failWatch?: boolean;
  /** `changesSince` throws — a mailbox that attached cleanly and then went bad. */
  failSync?: boolean;
  /**
   * The EXACT value `connect()` throws — the shape seam the auth classification needs.
   *
   * `failConnect` throws a plain `Error` on purpose (it is the honest shape for "we could not
   * name it"), and that makes it useless for any claim about CLASSIFICATION: the whole content of
   * the auth classification is which properties a real failure carries, and a fake that can only produce a
   * bare Error can assert that a mailbox was quarantined but never that it was quarantined as the
   * right KIND of failure. Takes precedence over `failConnect` when both are set.
   *
   * `unknown` rather than `Error`, so a test can hand over the non-Error shapes the classifier is
   * also required to survive.
   */
  connectError?: unknown;
  /** The exact value `changesSince` throws. Same reason as {@link connectError}, on the sync path. */
  syncError?: unknown;
  /**
   * Messages `changesSince` hands the worker on every call, as raw RFC822.
   *
   * Real mail, in a fake adapter, because some claims are only about what ARRIVES: the
   * classifier-outage test has to show that a message still lands in the database and in the
   * folder the deterministic rules chose while the model is down. An empty batch would prove
   * only that the worker did not crash.
   *
   * Reported until the worker's CURSOR knows the locator — which is what a real adapter does,
   * and the only behaviour that makes an outage test honest.
   *
   * The two naive alternatives both lie. Re-delivering unconditionally makes an already-ingested
   * message look like the USER moved it back to INBOX, and the reconciler's user-wins rule
   * (correctly) rewrites the routing decision. Draining on first read loses any message that a
   * mid-batch abort never got to — and a mid-batch abort is exactly what a classifier fault
   * produces, so the fake would erase the message whose fate is under test.
   */
  deliver?: Array<{
    from: string; subject: string; messageId: string; folder?: string;
    /** The server's own `\Seen` for this message — what a real adapter reports on the fetch. */
    seen?: boolean;
    /**
     * Extra raw header lines (`Name: value`), verbatim above `Subject`. What the guard
     * needs: a message carrying the provider's own `Authentication-Results` so the consent
     * demotion the REAL composition root wires (`index.ts#attach`) can be observed end to end.
     */
    headers?: string[];
    /** The top-level `Content-Type` and the body after the blank line, for a fixture whose BYTES are
     *  the subject (a long body, many parts). Absent: the one-line `text/plain` body. */
    contentType?: string;
    body?: string;
    /** A whole source to deliver instead of the one built from the fields above. */
    raw?: Buffer;
    /** The server's BODYSTRUCTURE for it, carried on the create as a real adapter does. */
    structure?: MimeStructure;
    /** Read out of the mailbox's own Sent folder — the stamp a real adapter puts on such a create. */
    ownAuthored?: boolean;
    /** The server's INTERNALDATE, carried on the create as a real adapter does. */
    internalDate?: Date;
  }>;
  /** `connect()` awaits this before proceeding (a takeover barrier). */
  gate?: Promise<void>;
  /**
   * `connect()` never settles, not even on a close or a force-close: a dial stuck in its TCP
   * connect or TLS handshake, which imapflow's `close()` does not end. Only the attach's own abort
   * (its deadline, or a stop) can let the attach go.
   */
  hangConnect?: boolean;
  /** Every `_meta` read of the lease hangs the same way, after a clean connect. */
  hangMeta?: boolean;
  /** `watch()` awaits this — parks an attach after its lease and folders, before IDLE. */
  watchGate?: Promise<void>;
  /** `changesSince` awaits this — parks a cycle IN FLIGHT so a stop() can land on it. */
  syncGate?: Promise<void>;
  /**
   * Hand back at most this many pending messages per call and set `hasBacklog` while more
   * remain — the real adapter's bounded backfill (`DEFAULT_SYNC_BATCH_MAX_MESSAGES`).
   *
   * Without a seam for it, no worker test can distinguish "ingested everything in one cycle"
   * from "drained a backlog across several", which is the behaviour that decides whether a
   * first sync of a real mailbox completes at all.
   */
  batchSize?: number;
  /**
   * Inbound `\Seen` changes `changesSince` reports ONCE and then forgets — the shape a real
   * CONDSTORE fast path produces after someone reads mail in another client.
   *
   * Drained on read, unlike `deliver`: a flag change carries no body and has no cursor of its
   * own, so re-reporting it forever would make "the worker adopted it" indistinguishable from
   * "the worker adopts it every cycle", and the user-wins test could never observe a decision
   * being made only once.
   */
  flagChanges?: Array<{ folder?: string; ref: string; seen: boolean }>;
  /**
   * A message the worker already holds, moved by the person in another client: reported ONCE as a
   * correlated `move` into `toFolder` (the only evidence an adoption takes), then forgotten, for the
   * reason `flagChanges` is drained. The bytes are `rawOf`'s, so the message dedups onto its row.
   */
  externalMoves?: Array<{ from: string; subject: string; messageId: string; toFolder: string; uid: number }>;
  /**
   * Recipient addresses the mailbox's Sent folder would yield to the kickstart.
   *
   * Absent ⇒ an empty scan, which is what a mailbox with no Sent folder produces — so every
   * pre-C2 test in this suite keeps its exact behaviour while the kickstart still runs its
   * (empty) pass over them. `scanSentRecipients` COUNTS its calls into `sentScans` for the same
   * reason `flagWrites` records writes: "the worker did not rescan on the second connect" is an
   * assertion about an absence, and an absence needs a counter to be observable at all.
   */
  sentRecipients?: string[];
  /**
   * Messages the server HOLDS and `changesSince` no longer enumerates — reachable only by UID. That is
   * what a written-off message is: its UID sits behind the folder's watermark and inside every
   * known-set, so the ordinary batch never offers it again and only {@link MailboxAdapter.fetchByUid}
   * reaches it. Modelling it as a `deliver` entry would put it back in the batch, the ingest loop would
   * take it, and a "the targeted retry recovered this" assertion would be measuring the ordinary path.
   * The UID is the fixture's own, never derived, because the durable `message_failures` row names it.
   * Served only when {@link FakeAdapterFleet.targetedRetry} is on.
   */
  behindWatermark?: Array<{
    from: string; subject: string; messageId: string; folder?: string; uid: number;
    seen?: boolean; headers?: string[]; contentType?: string; body?: string;
  }>;
}

/**
 * The RFC822 bytes a fixture message is served as — ONE builder for both doors. `changesSince` and the
 * targeted re-read must hand back the same bytes for the same message, or a retry would ingest something
 * the batch never offered and `planChange`'s dedup key would move under it; two inline builders cannot
 * be held to that and one can. EXPORTED for the same reason it is shared inside this file: a test that
 * seeds a database row whose identity must match what a door will serve has to normalize THESE bytes,
 * and copying the builder into the test would be a third one free to drift from both.
 */
export function rawOf(m: {
  from: string; subject: string; messageId: string; headers?: string[]; contentType?: string; body?: string;
}): Buffer {
  return Buffer.from([
    `Message-ID: <${m.messageId}>`, `From: ${m.from}`, "To: mila@lichtgrat.example",
    ...(m.headers ?? []),
    `Subject: ${m.subject}`, `Content-Type: ${m.contentType ?? "text/plain"}`, "", m.body ?? "hello",
  ].join("\r\n"));
}

/**
 * ONE MAILBOX'S `ohmail/_meta`, in memory — a REAL `LeaseIo`, never a no-op.
 *
 * The fake fleet grows this so that every worker test in the suite EXERCISES the organizer lease
 * instead of skipping it. That is not thoroughness for its own sake: `readMailboxLease` throws
 * `LeaseUnavailableError` when an adapter cannot hand over a `LeaseIo`, precisely so a missing
 * gate can never be the silently permissive branch — and a fake without one would turn every
 * fake-adapter test red for the wrong reason while proving nothing about the gate.
 *
 * It is keyed on the mailbox and OUTLIVES the adapter, because that is what a folder on a server
 * does: a re-attach after a quarantine has to find the claim the previous attach wrote, or
 * own-role resumption could not be observed at all.
 *
 * A test can pre-seed a FOREIGN claim through {@link FakeAdapterFleet.seedClaim} — that is how
 * "another organizer holds this mailbox" is produced without a second worker.
 */
export class FakeMetaFolder implements LeaseIo, ProfileIo {
  private nextUid = 1;
  readonly messages: RawClaimMessage[] = [];
  created = false;
  subscribed = true;
  /** Every claim ever appended here, including expunged ones — the renew's audit trail. */
  appends = 0;
  removals = 0;
  /** Every PROFILE document ever appended — the write-behind's debounce assertions read this. */
  profileAppends = 0;
  profileRemovals = 0;
  /**
   * THE CONNECTION UNDER THIS FOLDER IS DEAD — every operation throws `NoConnection`.
   *
   * ── WHY THE SEAM IS HERE AND NOT ON THE ADAPTER ────────────────────────────────────────────
   *
   * The production defect is a client object that still EXISTS and whose every command throws:
   * imapflow's `exec()` rejects with `code: "NoConnection"` on a closed-but-extant client
   * (`imap-flow.js:626-631`), and pending locks and requests are rejected with the same code at
   * `:2085`/`:2104`. There is no `getMailboxLock` in this fleet to intercept, and `failSync` is the
   * wrong seam entirely: it throws from `changesSince`, which lands in the ORDINARY failure arm and
   * quarantines after `maxSyncFailures`. The long outage happened in the arm that is exempt
   * from that count, and the only way into it is a lease read that throws — so this flag makes the
   * LEASE unreadable, and `runLeaseGate` wraps it into `LeaseUnavailableError` through exactly the
   * code path production took.
   *
   * It lives on the meta folder rather than on the adapter because the folder OUTLIVES the adapter
   * (as a folder on a server does), which is what lets a guard assert that the mailbox is re-dialled
   * and finds the lease still dead — the state that makes a detach-and-re-attach loop worth bounding
   * at all.
   */
  deadConnection = false;

  constructor(
    private readonly onEvent: (event: FakeEvent) => void = () => { /* untraced */ },
  ) {}

  /**
   * The shape `runLeaseGate` sees from a dead socket: a plain `Error` carrying imapflow's own
   * `code`, which the gate wraps as the `cause` of a `LeaseUnavailableError`. The observed
   * production line was `errorClass=LeaseUnavailableError causeClass=Error causeCode=NoConnection`,
   * and this reproduces all three.
   *
   * The message is deliberately content-free: `log.ts` reduces an `err` field to class + code and
   * discards the message, so a fake whose diagnostic value lived in the message would be testing
   * something production cannot see.
   */
  private refuseIfDead(): void {
    if (!this.deadConnection) return;
    throw Object.assign(new Error("imap connection is closed"), { code: "NoConnection" });
  }

  async ensureMetaFolder(): Promise<void> {
    this.refuseIfDead();
    this.created = true;
    this.subscribed = false;
  }

  async listClaims(): Promise<RawClaimMessage[]> {
    this.refuseIfDead();
    return this.messages.map((m) => ({ ...m }));
  }

  /**
   * THE FOLDER'S UID GENERATION, for the same reason {@link findOwnRecords} is here: every
   * adapter this repository builds reports one, so a double that leaves it out puts the gate in
   * a state the product never reaches — and the takeover's confirm is now required to refuse
   * there, because a ref means nothing without the numbering it was read under. Settable, so a
   * case can ask for the silent-server shape on purpose.
   */
  generation: number | bigint | null = 4_100;

  uidValidity(): number | bigint | null {
    return this.generation;
  }

  /**
   * THE FOLDER'S COUNTERS, as a STATUS answers them — what a permit asks between reads.
   *
   * Here for `uidValidity`'s reason: the one io this product ships always answers it, so a double
   * that stayed silent would leave every permit in this suite riding its clock to the boundary,
   * which is the state the fix exists to end. `null` while the connection is dead rather than a
   * throw, because that is what production does — the probe swallows every fault into "cannot
   * say", at a seam where a throw would be recorded as a message's own failure.
   */
  async stampMeta(): Promise<MetaFolderStamp | null> {
    this.stamps++;
    if (this.deadConnection) return null;
    return { uidValidity: this.generation, uidNext: this.nextUid, messages: this.messages.length };
  }

  /**
   * HOW MANY STATUSes THIS FOLDER HAS BEEN ASKED FOR — the permit's whole added cost, countable.
   * A claim that a mechanism pays "at most one STATUS" is a number or it is a hope.
   */
  stamps = 0;

  /**
   * WHICH RECORDS CARRY THIS INSTALL'S ID, wherever they sit — the server answering a header
   * search rather than a window being counted back from.
   *
   * Added because the release stopped having a window fallback. It never had one that was
   * REACHABLE in the product: every adapter this repository builds provides this method, so the
   * fallback could only ever be taken by a double, and a branch only a double reaches is a place
   * where the double's convenience quietly becomes the product's behaviour. Providing it here is
   * what makes this fake resemble the thing it stands in for.
   */
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    this.refuseIfDead();
    return this.messages
      .filter((m) => m.raw.includes(`X-Ohmail-Install-Id: ${installId}`))
      .map((m) => ({ ...m }));
  }

  async appendClaim(raw: string): Promise<void> {
    this.refuseIfDead();
    this.appends++;
    // `runLeaseGate` appends ONLY on an `organize` verdict, so this is the observable moment the
    // gate said yes — see the trace comment on `FakeAdapterFleet.trace`.
    this.onEvent("lease_organize");
    this.messages.push({ ref: this.nextUid++, raw });
  }

  async removeClaims(refs: readonly unknown[]): Promise<void> {
    // For fidelity, not for any assertion: a closed connection cannot EXPUNGE either. Unreachable
    // while dead in practice, because every caller reads the folder first and that already threw.
    this.refuseIfDead();
    this.onEvent("claim_remove");
    const gone = new Set(refs);
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (gone.has(this.messages[i]!.ref)) {
        this.messages.splice(i, 1);
        this.removals++;
      }
    }
  }

  // ── The PROFILE half — the same folder, seen through `ProfileIo` ─────────────────────────
  //
  // One in-memory `_meta` implements both interfaces, exactly as one real folder serves both:
  // the lease's reads see the profile documents (and parse them to `null`), the profile's reads
  // see the claims (and parse THEM to `null`). A separate store here would hide the one
  // co-tenancy bug worth having a fake for — a writer of one record type expunging the other's.
  // The fake stores full sources, so `listProfileMessages` (a `source: true` fetch in
  // production) and `listClaims` (headers-only) legitimately read the same array.

  /**
   * Full-source reads of the profile half — counted, because the ABSENCE of them is a claim.
   *
   * `importDecisionOpenNow` fetches the whole document out of `ohmail/_meta` on a TTL, and a
   * reader has no use for the answer: it files nothing, so the import decision cannot change what
   * its cycle does. An unseeded install's TTL is 30 s, so a reader that asked anyway would fetch
   * for the life of the attachment. Nothing recorded that, which is why it went unnoticed.
   */
  profileReads = 0;

  /**
   * THE FOLDER'S GENERATION THIS FAKE REPORTS, stamped at LIST time.
   *
   * `RawProfileMessage.generation` is required, because a uid remembered without the numbering it
   * was read under is a confident pointer at whatever holds that number now. The real io takes one
   * generation per SELECT and stamps every message in the call with it; this does the same, so a
   * test cannot accidentally measure a per-message generation the server never produces.
   */
  profileGeneration: number = 1_000;
  /** Simulate the server renumbering the folder: a new epoch, and the old uids mean nothing. */
  renumberProfiles(to: number): void { this.profileGeneration = to; }

  async listProfileMessages(): Promise<RawProfileMessage[]> {
    this.refuseIfDead();
    this.profileReads++;
    return this.messages.map((m) => ({ ...m, generation: this.profileGeneration }));
  }

  async appendProfile(raw: string): Promise<void> {
    this.refuseIfDead();
    this.profileAppends++;
    this.onEvent("profile_append");
    this.messages.push({ ref: this.nextUid++, raw });
  }

  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    this.refuseIfDead();
    const gone = new Set(refs);
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (gone.has(this.messages[i]!.ref)) {
        this.messages.splice(i, 1);
        this.profileRemovals++;
      }
    }
  }
}

/**
 * The adapter-visible moments a test can ORDER against each other.
 *
 * `sync_start` and `sync_end` are separate members deliberately: the non-blocking attach is a claim about
 * OVERLAP — "B's connect happened before A's second `changesSince` COMPLETED" — and a single
 * event per call cannot express the difference between a call that had started and one that had
 * finished. `lease_organize` is emitted from `appendClaim`, which `runLeaseGate` reaches only on
 * an `organize` verdict, so it is the gate's answer and not merely its attempt.
 */
export type FakeEvent =
  | "connect" | "close" | "ensure_folders" | "lease_organize"
  /** `connect()` was entered (before any gate), and `forceClose()` was called. */
  | "connect_start" | "force_close"
  | "sync_start" | "sync_end" | "watch" | "rearm" | "move"
  /** A targeted re-read by UID — the retry's and the junk restore's door into the folder. */
  | "fetch_by_uid"
  /** A settings document appended, and a claim removal asked of `_meta` — the release's order. */
  | "profile_append" | "claim_remove";

export interface FakeTraceEntry {
  mailboxId: string;
  event: FakeEvent;
  /** Monotonic ms since the fleet was constructed — for reporting, never for assertions. */
  atMs: number;
}

export class FakeAdapterFleet {
  /**
   * THE READER PEEK, ON — because `ImapAdapter.leasePeekIo()` always exists, and a fleet without it
   * modelled an adapter that cannot occur: every reader's holder columns were written by the
   * fixture, and a release could not read the folder at all. `false` is the blind shape, kept for
   * the control that shows what the peek changes; a folder that cannot be looked at is
   * `peekRefusal`, the product io's own refusal.
   */
  leasePeek = true;
  /** When set, the read side refuses with it — `MetaEnumRefusedError` for a folder past every read. */
  peekRefusal: Error | null = null;
  /** mailboxId → how many times the read side was opened; a look needs a counter to be observable. */
  readonly peekReads = new Map<string, number>();
  /**
   * THE TARGETED RE-READ, off by default — `leasePeek`'s shape, and the default is measured.
   * `retryFailedMessages` returns at its first line unless the adapter offers `fetchByUid`, so this
   * fleet could not reach the durable ledger's retry at all. OFF BY DEFAULT IS A KNOWN DIVERGENCE:
   * `ImapAdapter.fetchByUid()` always exists, so a fleet without it models an adapter that cannot occur.
   * Turning it on was MEASURED on 2026-09-14, not assumed — 8.00 to 10.00 statements per CYCLE, because
   * two passes gate on the method; per-MESSAGE cost is unchanged at 24.00 statements and 2.00
   * transactions, so the round-trip pins stay green. What stays unmeasured, and why the default stays
   * off: what those passes do to fixtures that have never run them (`leasePeek` reddened two that way).
   */
  targetedRetry = false;
  /** Every targeted re-read this fleet served — an absence needs a counter to be observable. */
  readonly targetedFetches: Array<{
    mailboxId: string; folder: string; uids: number[]; maxBytes?: number;
  }> = [];
  /** Per-mailbox behaviour, mutable at runtime. */
  readonly control = new Map<string, FakeControl>();
  /**
   * mailboxId → its `ohmail/_meta`. Created on first touch and kept for the life of the fleet,
   * so it survives a detach exactly as the folder on a real server does.
   */
  readonly meta = new Map<string, FakeMetaFolder>();

  /**
   * EVERY observable moment, in the order the worker caused it — the seam the attach case needs.
   *
   * The counters above (`connects`, `syncs`) answer "how many" and cannot answer "in what order",
   * which is the entire content of "cold-boot attach is serial and drains inline": a worker that
   * drains mailbox A fully before dialling B and one that dials both and then drains produce
   * IDENTICAL counters. Ordering is the observation, so it is recorded rather than inferred.
   *
   * Append-only and never consulted by the worker, so it costs the rest of the suite nothing.
   */
  readonly trace: FakeTraceEntry[] = [];
  private readonly tracedFrom = Date.now();

  private note(mailboxId: string, event: FakeEvent): void {
    this.trace.push({ mailboxId, event, atMs: Date.now() - this.tracedFrom });
  }

  /** The trace positions of one mailbox's `event`s, oldest first. */
  indicesOf(mailboxId: string, event: FakeEvent): number[] {
    const out: number[] = [];
    this.trace.forEach((e, i) => { if (e.mailboxId === mailboxId && e.event === event) out.push(i); });
    return out;
  }

  /** The trace position of the `nth` (1-based) `event` for `mailboxId`, or `Infinity`. */
  nth(mailboxId: string, event: FakeEvent, n: number): number {
    return this.indicesOf(mailboxId, event)[n - 1] ?? Infinity;
  }

  /** `mailboxId:event` in order — a readable failure message for an ordering assertion. */
  describeTrace(names: Map<string, string> = new Map()): string {
    return this.trace
      .map((e) => `${names.get(e.mailboxId) ?? e.mailboxId.slice(0, 8)}:${e.event}@${e.atMs}ms`)
      .join(" → ");
  }

  metaFor(mailboxId: string): FakeMetaFolder {
    let folder = this.meta.get(mailboxId);
    if (!folder) {
      folder = new FakeMetaFolder((event) => { this.note(mailboxId, event); });
      this.meta.set(mailboxId, folder);
    }
    return folder;
  }

  /** Put a claim in a mailbox's `_meta` before the worker ever looks — a foreign organizer. */
  seedClaim(mailboxId: string, raw: string): void {
    void this.metaFor(mailboxId).appendClaim(raw);
  }

  /**
   * the connection under this mailbox is dead or alive again.
   *
   * Every lease operation throws `NoConnection` while `dead` — see {@link FakeMetaFolder.deadConnection}
   * for why that is the seam. Deliberately NOT reset by a detach: the folder outlives the adapter,
   * so a re-attach finds the lease exactly as dead as the previous connection left it, which is the
   * state the detach bound has to be measured in.
   */
  killLease(mailboxId: string, dead = true): void {
    this.metaFor(mailboxId).deadConnection = dead;
  }
  created = 0;
  connects = 0;
  closes = 0;
  syncs = 0;
  /** Sync calls currently parked inside `changesSince` (see `syncGate`). */
  syncInFlight = 0;
  /** `connect()` calls entered and not yet returned, and the most there ever were at once. */
  connectInFlight = 0;
  connectPeak = 0;
  /** `forceClose()` calls, in total. */
  forceCloses = 0;
  /** mailboxId → currently-open adapter instances. A leak shows up as a lingering entry. */
  readonly open = new Map<string, number>();
  /** mailboxId → fire an IDLE signal into the worker (set once watch() succeeds). */
  readonly signal = new Map<string, () => void>();
  /**
   * Every `setFlags` the worker issued, in order — a REAL recording implementation and not a
   * silent no-op.
   *
   * A `async setFlags() {}` here would have satisfied the type and made every read-state
   * assertion in the suite vacuous: "the worker pushed \Seen" and "the worker did nothing"
   * produce identical green. Worse, the user-wins guard's whole content is that a call does NOT
   * happen, and you cannot assert the absence of a call against a fake that never records one.
   * The list below is what those tests read.
   */
  readonly flagWrites: Array<{ mailboxId: string; locator: NativeLocator; seen: boolean }> = [];
  /**
   * Every `move` the worker issued, in order — the organizer's one exclusive act.
   *
   * A reader marks mail read and sends; it does not file. So `movesFor(id).length === 0` is the
   * assertion that separates "stood down" from "still organizing" now that a loser stays
   * connected and keeps syncing, and the counters that used to carry that meaning (`syncs`,
   * `stats().mailboxes`) no longer can.
   */
  readonly moves: Array<{ mailboxId: string; locator: NativeLocator; toFolder: string }> = [];

  /** The folders this worker filed one mailbox's mail into, in order. */
  movesFor(mailboxId: string): string[] {
    return this.moves.filter((m) => m.mailboxId === mailboxId).map((m) => m.toFolder);
  }
  /** mailboxId → how many times the kickstart asked this mailbox's Sent folder for recipients. */
  readonly sentScans = new Map<string, number>();
  /** Locator refs whose `setFlags` throws `MessageGoneError` — it left the locator mid-cycle. */
  readonly goneFlagRefs = new Set<string>();
  /**
   * mailboxId → the worker's `onConnectionError` callback for that adapter.
   *
   * A real `ImapFlow` reports a dead socket by EMITTING `error`, not by rejecting anything a
   * caller is awaiting, and with no listener Node turns that into a process exit — the kill
   * mechanism of the 2026-08-02 outage. A fake adapter cannot produce a socket, so
   * {@link killConnection} produces the one thing that matters: the callback firing out of
   * band, from no call stack the worker owns.
   */
  readonly connectionErrorHandlers = new Map<string, (err: unknown) => void>();

  /** Fire an asynchronous connection failure for one mailbox, as imapflow's emitter would. */
  killConnection(mailboxId: string, code = "ETIMEOUT"): void {
    const handler = this.connectionErrorHandlers.get(mailboxId);
    if (!handler) throw new Error(`no connection-error handler registered for ${mailboxId}`);
    const err = new Error("socket timeout") as Error & { code: string };
    err.code = code;
    handler(err);
  }

  /**
   * Fire a connection that merely ENDED, as `ImapAdapter`'s `close` listener now does.
   *
   * The REAL class from `@trafficflow/core/adapters/imap`, never a look-alike: the worker
   * discriminates this shape from an `error` by `instanceof`, and a fake that fabricated its own
   * object would assert that a branch exists without asserting that production can reach it.
   * {@link killConnection} stays the `error` shape, so the 2026-08-02 guard keeps testing what it
   * always tested.
   */
  closeConnection(mailboxId: string): void {
    const handler = this.connectionErrorHandlers.get(mailboxId);
    if (!handler) throw new Error(`no connection-error handler registered for ${mailboxId}`);
    handler(new ImapConnectionClosedError());
  }

  behave(mailboxId: string, control: FakeControl): void {
    this.control.set(mailboxId, { ...this.control.get(mailboxId), ...control });
  }

  /** Adapters that connected and were never closed — a leaked provider login. */
  get openCount(): number {
    let n = 0;
    for (const v of this.open.values()) n += v;
    return n;
  }

  openFor(mailboxId: string): number { return this.open.get(mailboxId) ?? 0; }

  readonly factory = (
    _cfg: ImapConfig,
    ctx: { accountId: string; mailboxId: string; onConnectionError: (err: unknown) => void },
  ): MailboxAdapter => {
    this.created++;
    const id = ctx.mailboxId;
    this.connectionErrorHandlers.set(id, ctx.onConnectionError);
    const ctl = (): FakeControl => this.control.get(id) ?? {};
    let connected = false;
    const fleet = this;
    /** Resolved by this adapter's own close or force-close: what a hung `_meta` read waits on. */
    let closedNow!: () => void;
    const closedSignal = new Promise<void>((r) => { closedNow = r; });
    const noConnection = (): Error => Object.assign(new Error("imap connection is closed"), { code: "NoConnection" });
    /** A lease io over `meta` whose every read hangs until this adapter closes (see `hangMeta`). */
    const leaseIoFor = (meta: FakeMetaFolder): LeaseIo => {
      const hang = async <T>(): Promise<T> => { await closedSignal; throw noConnection(); };
      return {
        ensureMetaFolder: () => hang(),
        listClaims: () => hang(),
        findOwnRecords: () => hang(),
        appendClaim: () => hang(),
        removeClaims: () => hang(),
        stampMeta: () => hang(),
        uidValidity: () => meta.uidValidity(),
      } as LeaseIo;
    };

    const cursor: ChangeBatch = {
      creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
    };

    const connectBody = async (): Promise<void> => {
      const gate = ctl().gate;
      if (gate) await gate;
      if (ctl().hangConnect) await new Promise<never>(() => { /* see `hangConnect` */ });
      // `!== undefined` and not `in`, so `behave(id, { connectError: undefined })` CLEARS the
      // seam the way `failConnect: false` does — `behave` merges, so an `in` test would leave a
      // recovered mailbox throwing `undefined` for ever.
      const connectError = ctl().connectError;
      if (connectError !== undefined) throw connectError;
      if (ctl().failConnect) throw new Error(`fake connect refused (${id})`);
      fleet.connects++;
      connected = true;
      fleet.open.set(id, (fleet.open.get(id) ?? 0) + 1);
      fleet.note(id, "connect");
    };

    return {
      // The organizer lease's IO, bound to this mailbox's in-memory `_meta`. Structurally what
      // `ImapAdapter.leaseIo()` returns, which is what the worker probes for.
      /* ── THESE REFUSE AN IDENTITY THEY CANNOT KEY A MEMORY BY, AS THE REAL ONES DO ────────
       *
       * The concrete adapter asserts here, and this double did not — so a host that called these
       * with nothing at all typechecked against ITS OWN interface, threw at run time against the
       * real adapter, and passed every test against this one. That is exactly how the organizer's
       * profile path came to pass no identity: the throw was swallowed by a path designed to log
       * profile faults and carry on, so real profile synchronization was off and nothing said so.
       *
       * A double that accepts what the real thing refuses cannot catch that, whatever else it
       * models correctly. */
      leaseIo(identity: { installId: string; mailboxId: string }): LeaseIo {
        assertMetaIdentity("fake leaseIo", identity);
        // The real folder unless this adapter's `_meta` is to hang: identity is kept for every other case.
        return ctl().hangMeta ? leaseIoFor(fleet.metaFor(id)) : fleet.metaFor(id);
      },
      /* The READ side of the same folder, narrow as the product's (`LeasePeekIo` is one method).
         `refreshReaderHolder` probes for it by name, so an absent one is a silent skip. */
      ...(fleet.leasePeek ? {
        leasePeekIo: (): LeasePeekIo => {
          fleet.peekReads.set(id, (fleet.peekReads.get(id) ?? 0) + 1);
          const meta = fleet.metaFor(id);
          return {
            listClaims: async () => {
              if (fleet.peekRefusal) throw fleet.peekRefusal;
              return meta.listClaims();
            },
          };
        },
      } : {}),
      // The portable profile's IO — the SAME folder, through the other interface, exactly as
      // `ImapAdapter.profileIo(TEST_META_ID)` hands out the same connection's `_meta`.
      profileIo(identity: { installId: string; mailboxId: string }): ProfileIo {
        assertMetaIdentity("fake profileIo", identity);
        return fleet.metaFor(id);
      },
      async connect(): Promise<void> {
        fleet.note(id, "connect_start");
        fleet.connectInFlight++;
        fleet.connectPeak = Math.max(fleet.connectPeak, fleet.connectInFlight);
        try {
          await connectBody();
        } finally {
          fleet.connectInFlight--;
        }
      },
      forceClose(): void {
        fleet.forceCloses++;
        fleet.note(id, "force_close");
        closedNow();
        if (connected) {
          connected = false;
          fleet.open.set(id, Math.max(0, (fleet.open.get(id) ?? 0) - 1));
        }
      },
      async close(): Promise<void> {
        fleet.closes++;
        fleet.note(id, "close");
        closedNow();
        if (connected) {
          connected = false;
          fleet.open.set(id, Math.max(0, (fleet.open.get(id) ?? 0) - 1));
        }
      },
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {
        if (ctl().failEnsureFolders) throw new Error(`fake ensureFolders failed (${id})`);
        fleet.note(id, "ensure_folders");
      },
      async changesSince(c: ImapCursor): Promise<ChangeBatch> {
        fleet.note(id, "sync_start");
        const syncGate = ctl().syncGate;
        if (syncGate) {
          fleet.syncInFlight++;
          try { await syncGate; } finally { fleet.syncInFlight--; }
        }
        const syncError = ctl().syncError;
        if (syncError !== undefined) throw syncError;
        if (ctl().failSync) throw new Error(`fake sync failed (${id})`);
        fleet.syncs++;
        // LAST, so `sync_end` is the position at which this call's result is known. Every `return`
        // below carries the same event; a single note at the top would make the trace unable to
        // distinguish "started" from "completed", which is the whole claim under test.
        fleet.note(id, "sync_end");
        // Drained on read (see `FakeControl.flagChanges`) — reported once, then gone.
        const flags = ctl().flagChanges ?? [];
        const flagChanges = flags.map((f) => ({
          type: "flag" as const,
          locator: { folder: f.folder ?? "INBOX", ref: f.ref },
          seen: f.seen,
        }));
        if (flags.length > 0) fleet.behave(id, { flagChanges: [] });
        const ext = ctl().externalMoves ?? [];
        const moves = ext.map((m) => ({
          type: "move" as const, locator: { folder: m.toFolder, ref: `9:${m.uid}` }, seen: false, raw: rawOf(m),
        }));
        if (ext.length > 0) fleet.behave(id, { externalMoves: [] });
        const deliver = ctl().deliver;
        if (!deliver || deliver.length === 0) return { ...cursor, flagChanges, ...(moves.length > 0 ? { moves } : {}) };
        // Only what the cursor has not already seen — `buildCursor` fills `known` from the
        // database, so a message stops being reported the moment it is actually ingested.
        const pending = deliver
          .map((m, i) => ({ m, uid: 1000 + i }))
          .filter(({ m, uid }) => !(c.folders[m.folder ?? "INBOX"]?.known ?? []).some((k) => k.uid === uid));
        if (pending.length === 0) return { ...cursor, flagChanges, ...(moves.length > 0 ? { moves } : {}) };
        const cap = ctl().batchSize;
        const served = cap === undefined ? pending : pending.slice(0, cap);
        return {
          ...cursor,
          flagChanges,
          ...(moves.length > 0 ? { moves } : {}),
          hasBacklog: served.length < pending.length,
          creates: served.map(({ m, uid }) => ({
            type: "create" as const,
            locator: { folder: m.folder ?? "INBOX", ref: `1:${uid}` },
            seen: m.seen ?? false,
            raw: m.raw ?? rawOf(m),
            ...(m.structure !== undefined ? { structure: m.structure } : {}),
            ...(m.ownAuthored !== undefined ? { ownAuthored: m.ownAuthored } : {}),
            ...(m.internalDate !== undefined ? { internalDate: m.internalDate } : {}),
          })),
        };
      },
      /**
       * A RECORDING move, and the second parameter is why it exists.
       *
       * This was `async move(locator) { return locator; }` — the signature satisfied, the
       * destination dropped, nothing written down. That made every "a reader moves nothing"
       * assertion unwritable for exactly the reason {@link FakeAdapterFleet.flagWrites} gives one
       * paragraph over: you cannot assert the absence of a call against a fake that never records
       * one, and "the worker filed this message" and "the worker did nothing" produced identical
       * green. Filing mail into `ohmail/*` is THE act only an organizer may perform, so it is the
       * observation the lease's stand-down arms are really about.
       */
      async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
        fleet.moves.push({ mailboxId: id, locator, toFolder });
        fleet.note(id, "move");
        return locator;
      },
      async setFlags(locator: NativeLocator, flags: { seen: boolean }): Promise<void> {
        if (fleet.goneFlagRefs.has(locator.ref)) throw new MessageGoneError(locator);
        fleet.flagWrites.push({ mailboxId: id, locator, seen: flags.seen });
      },
      /* ── THE TARGETED RE-READ, present only when the fleet opts in — see `targetedRetry` ────
       *
       * Serves `behindWatermark` (the UIDs only this door can reach) and, by the SAME uid
       * arithmetic `changesSince` uses, whatever is still in `deliver`. Every named uid lands in
       * exactly one of the three answers, which is the contract the caller closes a durable record
       * against — a uid answered by none of them would leave `sync.ts` with no verdict to write. */
      ...(fleet.targetedRetry ? {
        async fetchByUid(
          folder: string, uids: readonly number[], opts?: FetchByUidOptions,
        ): Promise<TargetedFetch> {
          fleet.targetedFetches.push({
            mailboxId: id, folder, uids: [...uids],
            ...(opts?.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
          });
          fleet.note(id, "fetch_by_uid");
          type Held = {
            from: string; subject: string; messageId: string; seen?: boolean; headers?: string[];
            contentType?: string; body?: string;
          };
          const pool = new Map<number, Held>();
          (ctl().deliver ?? []).forEach((m, i) => {
            if ((m.folder ?? "INBOX") === folder) pool.set(1000 + i, m);
          });
          for (const m of ctl().behindWatermark ?? []) {
            if ((m.folder ?? "INBOX") === folder) pool.set(m.uid, m);
          }
          const creates: Change[] = [];
          const absent: number[] = [];
          const oversize: number[] = [];
          for (const uid of new Set(uids)) {
            const m = pool.get(uid);
            if (m === undefined) { absent.push(uid); continue; }
            const raw = rawOf(m);
            // Refused from the SIZE alone, body never built — the real adapter's pre-check.
            if (opts?.maxBytes !== undefined && raw.length > opts.maxBytes) { oversize.push(uid); continue; }
            creates.push({
              type: "create", locator: { folder, ref: `1:${uid}` }, seen: m.seen ?? false, raw,
            });
          }
          // The epoch `changesSince` stamps into every ref it mints, so a record written from one
          // door is usable at the other. A fixture that answered a different one would read as a
          // UIDVALIDITY reset and close every record it was asked about.
          return { uidValidity: "1", creates, absent, oversize };
        },
      } : {}),
      async scanSentRecipients(limit?: number): Promise<string[]> {
        fleet.sentScans.set(id, (fleet.sentScans.get(id) ?? 0) + 1);
        const all = ctl().sentRecipients ?? [];
        return limit === undefined ? [...all] : all.slice(0, limit);
      },
      async watch(onSignal: () => void): Promise<() => Promise<void>> {
        const watchGate = ctl().watchGate;
        if (watchGate) await watchGate;
        if (ctl().failWatch) throw new Error(`fake watch failed (${id})`);
        fleet.note(id, "watch");
        fleet.signal.set(id, onSignal);
        return async () => { fleet.signal.delete(id); };
      },
      // The post-visit re-arm (see `MailboxAdapter.rearmWatch`). Recorded so the guard for "every
      // successful visit puts the connection back on watch" can read the order, and a fake that
      // silently lacked it would make that assertion unwritable rather than vacuous.
      async rearmWatch(): Promise<void> {
        fleet.note(id, "rearm");
      },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("fake adapter cannot send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("fake adapter cannot fetchPart"); },
    };
  };
}
