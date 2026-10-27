import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isNull } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import { ImapBoundExceeded, ImapConnectionClosedError } from "@trafficflow/core/adapters/imap";
import type {
  LeaseIo, LeasePeekIo, RawClaimMessage, RequestOrganizerIo, RequestReaderIo,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { mailboxes } from "@trafficflow/db";
import { describeError } from "@trafficflow/core";
import { freshDataDir } from "./_datadir.js";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import type { Route } from "@trafficflow/api/local";
import {
  ConnectionReplacedError, createSidecar, credentialsRefused, isConnectionFailure, withForcedRedial,
  LOCAL_CONNECTION_DEAD_AFTER_CYCLES, LOCAL_CONNECTION_DEAD_AFTER_MS, DEFAULT_HEARTBEAT_TIMEOUT_MS, resolveHeartbeatTimeoutMs,
  REDIAL_BACKOFF_BASE_MS, REDIAL_BACKOFF_MAX_MS,
  DESKTOP_RECONNECT, PHONE_RECONNECT, RECONNECT_PROFILES, reconnectProfile, redialStepMs,
  settledWithin,
  type AdapterDialContext, type ReconnectProfile, type Sidecar,
} from "../src/engine.js";
import type { OrganizerKind } from "@trafficflow/core/adapters/organizer-lease";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CONNECTION DIED AND THE PROCESS DID NOT — the desktop's silent stop
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A desktop process outlives its sockets. The lid closes past the provider's idle timeout, the
 * Wi-Fi changes, a VPN flaps, the server sends `BYE` — and the engine keeps running with a poll
 * timer aimed at a connection that is gone. Measured on a real device: the last good drain, then
 * `sync_cycle_failed` with `errorClass: "LeaseUnavailableError"` and `causeCode: "NoConnection"`
 * every poll interval, unbroken, for as long as it was watched. Only quitting and reopening the
 * app cleared it.
 *
 * That is this repository's `failure-looks-like-healthy` shape in its worst form. The process is
 * up, the window is live, the mirror serves — and the mailbox is not being organized at all,
 * while the claim in `ohmail/_meta` ages out so another install becomes entitled to take the
 * mailbox from under one that still believes it holds it.
 *
 * ── WHY A FAKE THAT IS *NO MORE GENEROUS* THAN THE REAL ADAPTER IS THE WHOLE TEST ─────────
 *
 * `ImapAdapter` reports an asynchronous death exactly one way — `guardAsyncErrors` listens for
 * imapflow's `error` and `close` and calls `onConnectionError` — and after that death every
 * command on the same client throws imapflow's `NoConnection`. {@link FakeConnection} models
 * BOTH halves, and the second half is the one a lenient double would omit: a fake that kept
 * answering after the close would let a broken engine pass, because nothing downstream would
 * ever fail. Its three guards are the real class's, named on the real class's fields:
 *
 *  · `closedByUs` mirrors `ImapAdapter#closing` — a teardown we asked for emits no report;
 *  · `live` mirrors `ImapAdapter#established` — a connection that never came up emits none either;
 *  · every method asserts `live` first, which is imapflow's post-death behaviour and the reason
 *    the lease read comes back as `LeaseUnavailableError` rather than as a clean "nobody holds it".
 *
 * The one thing the fake is deliberately allowed that the real client is not: the test decides
 * WHEN the socket dies. That is the point of the seam.
 */

/** An in-memory `ohmail/_meta`. Its liveness is the CONNECTION's — see {@link FakeConnection}. */
class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /** A live socket whose `ohmail/_meta` cannot be read — a permission change, a provider that
   *  refuses FETCH on an empty mailbox. The connection is fine; the lease is not. */
  unreadable = false;
  /** Awaited inside `listClaims`, so a test can act while the organizer gate is mid-read. */
  parkRead: { entered: () => void; wait: Promise<void> } | null = null;
  private refuse(): void {
    if (this.unreadable) throw new Error("NO [SERVERBUG] the folder could not be read");
  }
  async ensureMetaFolder(): Promise<void> { this.refuse(); }
  async listClaims(): Promise<RawClaimMessage[]> {
    this.refuse();
    if (this.parkRead) {
      const park = this.parkRead;
      this.parkRead = null;                 // once: the re-read after release must not re-park
      park.entered();
      await park.wait;
    }
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
  /** How many claims have EVER been appended — renewal is append-then-expunge, so this is the
   *  only way from outside to see whether a pass consulted the lease at all. */
  get appends(): number {
    return this.nextUid - 1;
  }
  get count(): number {
    return this.claims.length;
  }
}

/**
 * ONE DIALLED CONNECTION — the fake's model of one `ImapAdapter` instance.
 *
 * A class per dial and not one mutable double reused, because "the engine built a SECOND adapter"
 * is the observation the re-dial is judged by, and a double that healed itself in place could
 * not tell a re-dial from a lucky retry.
 */
class FakeConnection {
  /** `ImapAdapter#established`: true between a completed `connect()` and the socket's end. */
  live = false;
  /** `ImapAdapter#closing`: a teardown WE asked for, which must not be reported as a death. */
  closedByUs = false;
  /** Every `close()` this connection was asked to perform, including the ones after it died. */
  closes = 0;
  /** `ensureFolders()` — the IMAP WRITE that creates somebody else's `ohmail/*` tree. */
  folderBuilds = 0;
  /** Filings. A stood-down install must never reach this. */
  moves = 0;
  /**
   * THE POST-DRAIN MAILBOX WRITES, which this double could not see at all.
   *
   * The real adapter exposes `requestOrganizerIo()`, `requestReaderIo()` and `profileIo()`, and
   * every one of them appends to or expunges from `ohmail/_meta` — the same folder the organizer
   * lease lives in. The fake exposed none, so a stale pass writing through all three was invisible
   * to every case in this file: an optional capability a double omits becomes a no-op, and a
   * no-op cannot be caught doing anything. That is the exact kindness that let the first round's
   * fix look complete while four write surfaces went unguarded.
   */
  requestAppends = 0;
  requestAcks = 0;
  requestRemovals = 0;
  profileAppends = 0;
  profileRemovals = 0;
  /**
   * MAKE THE NEXT `connect()` REJECT — a refused TCP connect, a TLS failure, a server that never
   * sends a greeting. The case that matters about it is that NOTHING IS EMITTED: there was never
   * an established connection to lose, so no listener fires and the only thing that knows is the
   * caller holding the rejected promise.
   */
  failNextConnect: Error | null = null;

  constructor(readonly onConnectionError: (err: unknown) => void) {}

  /**
   * WHAT THE SERVER DOES, not what we do: imapflow's `close` event on a live connection.
   *
   * The two early returns are `guardAsyncErrors`'s own, verbatim in effect — a close we asked
   * for and a connection that never came up are both silent there, and a fake that reported
   * them would let an engine pass that healed for the wrong reason.
   */
  killFromServer(): void {
    if (this.closedByUs || !this.live) return;
    this.live = false;
    this.onConnectionError(new ImapConnectionClosedError());
  }

  /**
   * imapflow's `error` EVENT — and this listener is UNGUARDED in the real adapter.
   *
   * `guardAsyncErrors` wraps only its `close` handler in `this.closing || !this.established`; the
   * `error` handler forwards unconditionally. So a connection we deliberately closed during a
   * re-dial can still report an error afterwards, from a socket whose replacement is already up.
   * The double modelled only the guarded path, which made it MORE GENEROUS than the adapter and
   * hid a real defect: that late report used to mark the healthy replacement dead.
   */
  errorFromServer(err: Error): void {
    this.onConnectionError(err);
  }

  /**
   * THE DEATH THAT REPORTS NOTHING — `imap.ts`'s own named case.
   *
   * `guardAsyncErrors` returns early for every client with no event surface, so an injected
   * double never reaches the `close` listener at all; and a socket that answers TCP while never
   * completing another IMAP command produces no `close` event even on a real client. Both are
   * the same thing from the engine's side: the connection is gone and nobody said so. The
   * duration bound is the only detector that covers it, which is why it exists beside the
   * listener rather than instead of it.
   */
  dieSilently(): void {
    this.live = false;
  }

  /**
   * The link went half-open: the socket is still there and every command hangs. Not
   * {@link dieSilently}, which is the death the client KNOWS about — there `live` goes false and
   * every command throws. Here `live` stays TRUE, because that is the state before anything
   * knows.
   */
  halfOpen = false;
  goHalfOpen(): void { this.halfOpen = true; }
  /**
   * THE LINK DIES AFTER THE NEXT NOOP IS ANSWERED — the door the shipped detector missed.
   *
   * {@link goHalfOpen} wedges the link BEFORE the drain's preflight, so the probe always sees
   * it. The sequence that was uncovered is the other order: the preflight answers, the link goes
   * half-open under it, and the command AFTER the probe is the one that hangs.
   */
  private halfOpenAfterNoop = false;
  goHalfOpenAfterNoop(): void { this.halfOpenAfterNoop = true; }
  /** Called by the double once a NOOP has been ANSWERED: the transition happens after the probe
   *  saw a live link, which is the order the shipped detector could not see. */
  noopAnswered(): void {
    if (!this.halfOpenAfterNoop) return;
    this.halfOpenAfterNoop = false;
    this.goHalfOpen();
  }

  /**
   * THE WIRE, SERIALIZED — what the fake could not model before, and the whole of HIGH 1.
   *
   * imapflow writes ONE command at a time: `exec` pushes onto `requestQueue` and `trySend` sends
   * only while nothing is in flight (`imap-flow.js:611-622`), so a NOOP issued during a long
   * FETCH is not written until that FETCH's tagged completion. A fake whose `noop()` resolved
   * independently of the command beside it could not produce that, which is why a heartbeat that
   * kills a healthy connection was green here.
   *
   * Ordinary fake commands resolve at once, so for every case that does not arm a slow one this
   * queue is a no-op.
   */
  private wireTail: Promise<unknown> = Promise.resolve();
  onWire<T>(run: () => Promise<T>): Promise<T> {
    const started = this.wireTail.then(run, run);
    this.wireTail = started.catch(() => undefined);
    return started;
  }

  /**
   * WHEN THE SERVER WAS LAST HEARD FROM — {@link MailboxAdapter.lastServerActivityAt}'s fact.
   *
   * The real adapter stamps this from imapflow's own per-line `log` event, so a streaming FETCH
   * advances it continuously and a half-open link never advances it at all. Here every answered
   * command stamps it, and {@link longCommand} stamps it on the way.
   */
  serverActivityAt: Date | null = null;
  heard(): void { this.serverActivityAt = new Date(); }

  /**
   * A HEALTHY COMMAND THAT TAKES LONGER THAN THE HEARTBEAT WINDOW — a large fetch, a slow
   * server. It is heard from every `heardEveryMs` on the way, which is what makes it a BUSY link
   * rather than a dead one, and it holds {@link onWire} for its whole run.
   */
  async longCommand(ms: number, heardEveryMs: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await new Promise<void>((r) => { setTimeout(r, Math.min(heardEveryMs, until - Date.now())); });
      this.heard();
    }
  }

  /** A link that is heard from while a command of its own hangs — see the re-arm case. */
  private heardTicker: ReturnType<typeof setInterval> | null = null;
  keepHeard(everyMs: number): void {
    this.heardTicker = setInterval(() => { this.heard(); }, everyMs);
    this.heardTicker.unref?.();
  }
  stopHeard(): void { if (this.heardTicker) clearInterval(this.heardTicker); this.heardTicker = null; }

  /** Commands this link has swallowed, each with the reject that ends it. */
  private readonly hung: Array<(err: Error) => void> = [];
  /**
   * How many NOOPs this connection was ISSUED — counted where the engine asks and not where the
   * wire carries it, because the two are the question: a probe queued behind a hung command is
   * issued and never sent, and a detector that stopped re-arming is invisible in a count of
   * sends. {@link noopSends} is the other half.
   */
  noops = 0;
  /** How many NOOPs actually reached the wire, and when each was sent and answered. */
  noopSends = 0;
  readonly noopTimings: Array<{ issuedAt: number; sentAt: number; answeredAt: number }> = [];
  /** How many times this connection was destroyed WITHOUT a LOGOUT. */
  forceCloses = 0;
  /** ARMED BY THE TEST: the NEXT `changesSince` is a healthy command of this length. */
  slowCycleMs: number | null = null;
  /** How often that command is heard from — a tenth of the heartbeat window in these cases, so
   *  the reading survives the scheduler rather than measuring it. */
  slowCycleHeardEveryMs = 25;
  /** How long a NOOP takes to answer ONCE IT IS ON THE WIRE — the interval the probe's own
   *  deadline is supposed to measure, kept distinct from the queue wait ahead of it. */
  noopAnswerMs = 0;
  /** A command that never answers. See {@link goHalfOpen}. */
  hang<T>(): Promise<T> {
    return new Promise<T>((_resolve, reject) => { this.hung.push(reject); });
  }
  /** End every hung command the way a destroyed socket does: they reject with imapflow's
   *  post-death error. Called by the double's `forceClose`, and by the test's own teardown. */
  endHangs(): void {
    const err = new Error("Connection not available") as Error & { code: string };
    err.code = "NoConnection";
    for (const reject of this.hung.splice(0)) reject(err);
  }

  /**
   * THE RIG LETTING GO OF A WEDGED LINK, for teardown only.
   *
   * A case that deliberately leaves the link half-open and LIVE hands the suite's own
   * `sidecar.stop()` a connection whose every command hangs — including the polite `close()`
   * `detach()` awaits. That wait is a real product hazard and has its own gap row; it is not
   * what those cases measure, and a hook that times out reports it as their failure. So the rig
   * ends the link itself first: hangs rejected, and the link marked gone so the teardown's
   * `close()` answers at once.
   */
  abandon(): void {
    this.endHangs();
    this.halfOpen = false;
    this.live = false;
  }

  /** imapflow after the socket is gone: every command throws, from a client that still exists. */
  assertLive(): void {
    if (this.live) return;
    const err = new Error("Connection not available") as Error & { code: string };
    err.code = "NoConnection";
    throw err;
  }
}

const EMPTY_BATCH: ChangeBatch = {
  creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
};

/**
 * One message the server holds, as RFC822 bytes.
 *
 * REAL SOURCE and not a hand-built normalized record: the pipeline refuses a create with no
 * `raw`, and the point of handing any over is that the pipeline actually RUNS — an organizer
 * files an unknown sender into `ohmail/Screener`, which is a `move`, and a reader files nothing.
 * That contrast is the only non-vacuous way to ask what role a drain ran under.
 */
function arrival(uid: number): Buffer {
  return Buffer.from([
    `Message-ID: <outage-${uid}@stranger.test>`,
    "From: stranger@elsewhere.test",
    "To: owner@trafficflow.test",
    `Subject: mail that arrived during the outage ${uid}`,
    "Date: Wed, 02 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

/** Every dial this install made, in order, and the adapters the engine got back. */
interface DialLog {
  readonly connections: FakeConnection[];
  readonly factory: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter;
  /** The connection the engine is using NOW — the last one dialled. */
  readonly current: FakeConnection;
}

/**
 * @param arrivedDuringTheOutage UIDs the server hands over on the first `changesSince` of every
 *   connection AFTER the first. Mail that landed while the socket was dead is the ordinary state
 *   on the way back, and it is what makes "did this drain run as an organizer or as a reader?"
 *   answerable at all: an organizer files an unknown sender, a reader does not.
 */
function dialLog(
  meta: MemoryMetaFolder,
  arrivedDuringTheOutage: number[] = [],
  /** Awaited inside the FIRST `changesSince` of the first connection, so a test can park a drain
   *  mid-cycle and act while it is suspended — which is the only way to produce the race in
   *  which a re-dial lands under a drain that has already read the lease. */
  parkFirstCycle?: { armed: boolean; entered: () => void; wait: Promise<void> },
  /** Applied to every dial AFTER the first: the re-dial's own `connect()`. */
  reDial?: { fails?: Error; park?: { entered: () => void; wait: Promise<void> } },
  /** `oneCycle` makes the parked connection report NO backlog, so the drain runs exactly one
   *  cycle and the POST-DRAIN block is the next thing to execute — the window the cycle-edge
   *  refusal never reaches. */
  opts?: {
    oneCycle?: boolean;
    /** ARMED BY THE TEST: serve one cycle with a backlog, then die SILENTLY before the next —
     *  the flap the per-cycle accounting exists for. Armable rather than always-on because the
     *  first drain of all is `start()`'s, and killing that one makes the fixture measure the
     *  launch instead of the flap. */
    dieAfterFirstCycle?: { armed: boolean };
    /** One entry per re-dial, in order: "fail" refuses its connect; a count serves that many
     *  cycles with a backlog and then the server closes the link; `park` holds cycle `at`;
     *  `breach` ends it with a read bound that names no message instead of a close. */
    reDialPlan?: ReadonlyArray<"fail" | number | {
      serve: number; breach?: true; park?: { at: number; entered: () => void; wait: Promise<void> };
    }>;
    /** The launch's second cycle reports the close and still answers "nothing left": the shape
     *  an adapter that read a closed link's folders as absent handed back. */
    answerAfterClose?: boolean;
  },
): DialLog {
  const connections: FakeConnection[] = [];
  const factory = (_cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter => {
    const conn = new FakeConnection(ctx.onConnectionError);
    const isReDial = connections.length > 0;
    let handedBacklog = false;
    let parked = false;
    let flapServed = false;
    const plan = isReDial ? opts?.reDialPlan?.[connections.length - 1] : undefined;
    let planServed = 0;
    connections.push(conn);
    /* THE FIVE ACCESSORS THIS DOUBLE OFFERS BESIDE `MailboxAdapter`, each named with the
       interface the real `ImapAdapter` returns from it. They are not on `MailboxAdapter` —
       production reaches them by duck-typing (`apps/sidecar/src/engine.ts` for the lease peek,
       `apps/worker/src/request-drain.ts` for the two request surfaces) — so an annotation that
       omits one lets the double drift from the shape that code probes for. */
    const adapter: MailboxAdapter & {
      leaseIo(): LeaseIo;
      leasePeekIo(): LeasePeekIo;
      profileIo(): ProfileIo;
      requestOrganizerIo(): RequestOrganizerIo;
      requestReaderIo(): RequestReaderIo;
    } = {
      /* THE LEASE IO IS THE CONNECTION'S. `ImapAdapter.leaseIo()` is a narrowing of the same
         socket, so a dead socket must make the lease unreadable — which is exactly how the
         measured wedge presented: `LeaseUnavailableError` wrapping `NoConnection`. Handing the
         lease folder over unconditionally would be the lenient double that hides the defect. */
      leaseIo: () => ({
        ensureMetaFolder: async () => { conn.assertLive(); await meta.ensureMetaFolder(); },
        listClaims: async () => { conn.assertLive(); return meta.listClaims(); },
        appendClaim: async (raw: string) => { conn.assertLive(); await meta.appendClaim(raw); },
        removeClaims: async (refs: readonly unknown[]) => {
          conn.assertLive();
          await meta.removeClaims(refs);
        },
        /* NOT behind `assertLive`, and that is the production shape: `makeLeaseIo` reads the
           generation off the client's selected mailbox, which a dead socket leaves UNKNOWN rather
           than throwing. A double that threw here would turn a silent server into a fault. */
        uidValidity: () => (conn.live ? meta.uidValidity() : null),
        /* THE SERVER-SIDE SEARCH BY INSTALL ID, and the double has to have it because the REAL
           adapter does. `releaseMailboxClaim` asks for our records by id and REFUSES to remove
           anything when it cannot — a partial release is worse than none — so a fake without this
           method makes every release throw, the detach arm swallows it, and the claim is stranded.
           That is a property of the double, not of the product: it made this file's detach case
           fail while production, which has the method, releases correctly. A double that lacks a
           capability production always has is the lenient double wearing a defect's clothes. */
        findOwnRecords: async (installId: string) => {
          conn.assertLive();
          const all = await meta.listClaims();
          return all.filter((m) => String(m.raw).includes(`X-Ohmail-Install-Id: ${installId}`));
        },
      }),
      leasePeekIo: () => ({
        listClaims: async () => { conn.assertLive(); return meta.listClaims(); },
      }),
      /* THE THREE POST-DRAIN SURFACES, each narrowing the SAME connection exactly as the real
         adapter's do — so a write through any of them is a write on THIS connection and is
         counted against it. */
      requestOrganizerIo: () => ({
        listMetaRecords: async () => { conn.assertLive(); return { records: [], count: 0, bytes: 0 }; },
        ack: async () => { conn.assertLive(); conn.requestAcks += 1; },
        remove: async () => { conn.assertLive(); conn.requestRemovals += 1; },
      }),
      requestReaderIo: () => ({
        listMetaRecords: async () => { conn.assertLive(); return { records: [], count: 0, bytes: 0 }; },
        append: async () => { conn.assertLive(); conn.requestAppends += 1; },
      }),
      profileIo: () => ({
        ensureMetaFolder: async () => { conn.assertLive(); },
        listProfileMessages: async () => { conn.assertLive(); return []; },
        appendProfile: async () => { conn.assertLive(); conn.profileAppends += 1; },
        removeProfiles: async () => { conn.assertLive(); conn.profileRemovals += 1; },
      }),
      async connect(): Promise<void> {
        if (conn.failNextConnect) {
          const err = conn.failNextConnect;
          conn.failNextConnect = null;
          throw err;
        }
        if (isReDial && reDial?.park) {
          reDial.park.entered();
          await reDial.park.wait;
        }
        if (isReDial && reDial?.fails) throw reDial.fails;
        if (plan === "fail") throw Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
        conn.live = true;
        conn.closedByUs = false;
      },
      /* THE POLITE PATH, WITH PRODUCTION'S OWN FAILURE MODE — which this double used not to have.
         `ImapAdapter.close()` issues a LOGOUT and IMAP commands are serialized, so on a link that
         is half-open (live as far as the driver knows, answering nothing) it queues behind the
         command already hung and NEVER SETTLES; the interface says so on `forceClose`. A double
         that returned here made every caller which AWAITED this teardown look safe, and two of
         them were not. A link the caller has already destroyed answers at once, exactly as the
         real one does through its `closing`/retired arm. */
      async close(): Promise<void> {
        conn.closes += 1;
        if (conn.halfOpen && conn.live) return conn.hang<void>();
        conn.closedByUs = true;
        conn.live = false;
      },
      /* No more generous than `ImapAdapter.noop`: raw, unbounded, and on a half-open link it
         neither resolves nor rejects. */
      async noop(): Promise<void> {
        /* ISSUED HERE — before the wire, deliberately. See `FakeConnection.noops`. */
        conn.noops += 1;
        const issuedAt = Date.now();
        return conn.onWire(async () => {
          /* SENT: the wire is ours now. The half-open arm is read HERE and not above, because a
             link that is already wedged never writes this command at all. */
          if (conn.halfOpen) return conn.hang<void>();
          const sentAt = Date.now();
          conn.noopSends += 1;
          conn.assertLive();
          if (conn.noopAnswerMs > 0) {
            await new Promise<void>((r) => { setTimeout(r, conn.noopAnswerMs); });
            conn.assertLive();
          }
          conn.heard();
          conn.noopTimings.push({ issuedAt, sentAt, answeredAt: Date.now() });
          /* AFTER the answer, so the probe that armed this one still sees a live link — the
             uncovered order. */
          conn.noopAnswered();
        });
      },
      lastServerActivityAt(): Date | null { return conn.serverActivityAt; },
      /* `ImapAdapter.forceClose`: destroy the socket, no LOGOUT, `closing` first so the death we
         caused reports nothing. Destroying it is also what ends the hung commands. */
      forceClose(): void {
        conn.forceCloses += 1;
        conn.closedByUs = true;
        conn.live = false;
        conn.endHangs();
      },
      async capabilities(): Promise<ImapCapabilities> {
        conn.assertLive();
        return {
          move: true, uidplus: true, condstore: true, qresync: false,
          idle: true, specialUse: true, sentFolder: null,
        };
      },
      async ensureFolders(): Promise<void> { conn.assertLive(); conn.folderBuilds += 1; },
      async changesSince(): Promise<ChangeBatch> {
        /* The half-open arm first: the link is LIVE in that state, so `assertLive` would wave it
           through and the drain would not park. */
        if (conn.halfOpen) return conn.hang<ChangeBatch>();
        conn.assertLive();
        /* A LEGITIMATELY LONG COMMAND, armed by the test: it holds the wire for its whole run,
           which is what puts the heartbeat's NOOP in the queue behind it. */
        if (conn.slowCycleMs !== null) {
          const ms = conn.slowCycleMs;
          conn.slowCycleMs = null;
          await conn.onWire(async () => { await conn.longCommand(ms, conn.slowCycleHeardEveryMs); });
          conn.assertLive();
          return { ...EMPTY_BATCH };
        }
        conn.heard();
        if (plan !== undefined && plan !== "fail") {
          planServed += 1;
          if (typeof plan === "object" && planServed === plan.park?.at) {
            plan.park.entered();
            await plan.park.wait;
            conn.assertLive();
          }
          if (planServed > (typeof plan === "number" ? plan : plan.serve)) {
            if (typeof plan === "object" && plan.breach) {
              const breach = new ImapBoundExceeded("read_bytes", 1_048_576, 1_600_000, "INBOX");
              conn.onConnectionError(breach);
              throw breach;
            }
            conn.killFromServer();
            conn.assertLive();
          }
          return { ...EMPTY_BATCH, hasBacklog: true };
        }
        if (opts?.answerAfterClose && !isReDial) {
          if (flapServed) { conn.killFromServer(); return { ...EMPTY_BATCH }; }
          flapServed = true;
          return { ...EMPTY_BATCH, hasBacklog: true };
        }
        if (opts?.dieAfterFirstCycle?.armed && !isReDial) {
          if (flapServed) { conn.dieSilently(); conn.assertLive(); }
          flapServed = true;
          return { ...EMPTY_BATCH, hasBacklog: true };
        }
        /* ARMED BY THE TEST, never on by default. The first cycle of all is `start()`'s own
           drain, so a barrier that fired unconditionally parked the BOOT and the whole file hung
           before a single assertion ran. */
        if (parkFirstCycle?.armed && !isReDial && !parked) {
          parked = true;
          parkFirstCycle.entered();
          await parkFirstCycle.wait;
        }
        if (parked && !isReDial) {
          /* THE PARKED CONNECTION HANDS OVER MAIL AND SAYS THERE IS MORE.
           *
           * `hasBacklog` is the adapter's own answer and `runSyncCycle` returns it verbatim, so
           * this is what makes the drain run a SECOND cycle — and a second cycle is the whole
           * point: the connection swap lands between the two, which is the window the cycle-edge
           * refusal exists for. Without it the drain ran exactly one cycle, the window was never
           * entered, and the case passed with the protection deleted. */
          if (opts?.oneCycle) { handedBacklog = true; return { ...EMPTY_BATCH }; }
          if (handedBacklog) return { ...EMPTY_BATCH, hasBacklog: true };
          handedBacklog = true;
          return {
            ...EMPTY_BATCH,
            hasBacklog: true,
            creates: [101, 102].map((uid) => ({
              type: "create" as const,
              locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
              raw: arrival(uid),
            })) as ChangeBatch["creates"],
          };
        }
        if (!isReDial || handedBacklog || arrivedDuringTheOutage.length === 0) {
          return { ...EMPTY_BATCH };
        }
        handedBacklog = true;
        return {
          ...EMPTY_BATCH,
          hasBacklog: true,
          creates: arrivedDuringTheOutage.map((uid) => ({
            type: "create" as const,
            locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
            raw: arrival(uid),
          })) as ChangeBatch["creates"],
        };
      },
      async move(locator: NativeLocator): Promise<NativeLocator> {
        conn.assertLive();
        conn.moves += 1;
        return locator;
      },
      async setFlags(): Promise<void> { conn.assertLive(); },
      async scanSentRecipients(): Promise<string[]> { conn.assertLive(); return []; },
      async watch(): Promise<() => Promise<void>> {
        conn.assertLive();
        return async () => {};
      },
      async send(): Promise<SendResult> {
        throw new Error("this test's mailbox must never be asked to send");
      },
      async fetchPart(): Promise<FetchedPart> {
        throw new Error("this mailbox cannot fetchPart");
      },
    };
    return adapter;
  };
  return {
    connections,
    factory,
    get current() { return connections[connections.length - 1]!; },
  };
}

const HOUR = 60 * 60 * 1000;

/**
 * THE HEARTBEAT WINDOW THESE CASES RUN AT — milliseconds, not the shipped thirty seconds, since
 * a suite may not wait half a minute. Every fixture interval below is a FRACTION or a MULTIPLE of
 * it: the two timing cases compare an interval against this window, and a fixture that ticked at
 * three quarters of it would be measuring the scheduler under load rather than the rule. Ten
 * times the margin is what makes the reading a decision.
 */
const WINDOW = 250;

describe("the engine re-dials a connection that died under it", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function dataDir(): Promise<string> {
    const dir = await freshDataDir("ohmail-reconnect-");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  /** Every log line this install emitted, so a state with no accessor is still observable. */
  interface Booted {
    sidecar: Sidecar;
    events: Array<{ event: string; detail: Record<string, unknown> }>;
  }

  /**
   * @param opts.heartbeatTimeoutMs The heartbeat window in real milliseconds — the only thing the
   *   half-open cases move; the detector, the stamp and the ladder are the shipped ones.
   * @param opts.now An injected clock, for the case whose subject is a once-a-minute floor.
   * @param opts.organizerKind What this composition claims as, which is what selects the
   *   reconnect profile. Absent is `local` — the shipped desktop door, and every case above.
   * @param opts.pollIntervalMs Real milliseconds, for the ONE case whose subject is the bound on
   *   how long a stop waits for its cycle. Everything else keeps the hour below.
   */
  async function boot(
    dir: string, dials: DialLog,
    opts: {
      heartbeatTimeoutMs?: number; now?: () => Date;
      organizerKind?: OrganizerKind; pollIntervalMs?: number; monotonic?: () => number;
    } = {},
  ): Promise<Booted> {
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine that was left open",
      /* LONG ENOUGH THAT THE TIMER NEVER FIRES ON ITS OWN: every pass below is one this test
         asked for, so a failure is a decision and never a race. The re-dial deliberately rides
         the DRAIN rather than the timer for exactly this reason — a heal only the poll could
         reach would be a heal no test could hold. */
      pollIntervalMs: opts.pollIntervalMs ?? 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      adapterFactory: dials.factory,
      log: (event, detail) => { events.push({ event, detail }); },
      ...(opts.heartbeatTimeoutMs === undefined
        ? {}
        : { heartbeatTimeoutMs: opts.heartbeatTimeoutMs }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      ...(opts.monotonic === undefined ? {} : { monotonic: opts.monotonic }),
      ...(opts.organizerKind === undefined ? {} : { organizerKind: opts.organizerKind }),
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    /* SOMEBODY AGREED TO LET THIS MACHINE ORGANIZE. A fresh mailbox is a consent-less reader, so
       without this the gate never reaches the lease at all and every case here would pass for the
       wrong reason with `ohmail/_meta` never read. Both columns, because they are two different
       readers: the gate reads the consent, every service write door reads the role. */
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));
    return { sidecar, events };
  }

  const seen = (b: Booted, event: string): Array<Record<string, unknown>> =>
    b.events.filter((e) => e.event === event).map((e) => e.detail);

  /**
   * WAIT FOR AN EFFECT THE ROUTE DELIBERATELY DOES NOT AWAIT, and give up.
   *
   * `POST /mailboxes/:id/resync` answers 202 — "queued" — and fires the forced re-dial without
   * awaiting it, because awaiting would hold the response for as long as a connect takes with
   * the pane's button disabled behind it. So a test that read the log on the line after the
   * press would be asserting the SCHEDULING, not the heal.
   *
   * Bounded rather than a fixed sleep: the bound IS the product's claim ("reconnected within a
   * few seconds of the press"), a fixed sleep would be either flaky or slow, and a wait with no
   * bound turns a broken heal into a hung suite instead of a failed assertion.
   */
  /**
   * THE PRESS, THROUGH THE ROUTE. Every control below goes through here.
   *
   * A refusal rule proven on a function while the ROUTE's pipeline supplies different operands
   * is this repository's named shape; the wrapper under test lives in the local composition, so
   * the only honest way to reach it is `sidecar.handle`.
   */
  const press = async (b: Booted, mailboxId: string): Promise<Response> =>
    b.sidecar.handle(new Request(
      `http://local/mailboxes/${encodeURIComponent(mailboxId)}/resync`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${b.sidecar.sessionToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    ));

  /**
   * Wait for the dial count to reach `n`, bounded by REAL TICKS rather than by a clock.
   *
   * The two cases below freeze `Date` to drive the base-step floor, so a deadline computed from
   * `Date.now()` never passes and a missing dial would hang the suite instead of failing it.
   * `setTimeout` is not faked, so counting ticks is a bound the frozen clock cannot defeat.
   *
   * USED FOR THE NEGATIVES TOO, deliberately: asked for a count that must NOT arrive, it spends
   * the whole budget and then reports what it saw, which is a fair chance to dial rather than a
   * fixed sleep that was long enough on an idle machine and not on a busy one. That is what a
   * six-file run turned up — the fixed 250 ms settle passed alone and failed beside its
   * neighbours, which is a flake, not a finding.
   */
  const untilDialsTicked = async (
    dials: DialLog, n: number, ticks = 200, everyMs = 25,
  ): Promise<number> => {
    for (let i = 0; i < ticks; i++) {
      if (dials.connections.length >= n) return dials.connections.length;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return dials.connections.length;
  };

  /** Wait, bounded by real ticks, for `event` to have been logged `n` times. */
  const untilEventTicked = async (
    b: Booted, event: string, n = 1, ticks = 200, everyMs = 25,
  ): Promise<number> => {
    for (let i = 0; i < ticks; i++) {
      const seenN = b.events.filter((e) => e.event === event).length;
      if (seenN >= n) return seenN;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    return b.events.filter((e) => e.event === event).length;
  };

  /** Wait, bounded, for the dial count to reach `n` — the fire-and-forget effect. */
  const untilDials = async (dials: DialLog, n: number, budgetMs = 5_000): Promise<number> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      if (dials.connections.length >= n) return dials.connections.length;
      if (Date.now() >= deadline) return dials.connections.length;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  const until = async (
    b: Booted, event: string, count = 1, budgetMs = 5_000,
  ): Promise<Array<Record<string, unknown>>> => {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const hits = seen(b, event);
      if (hits.length >= count) return hits;
      if (Date.now() >= deadline) return hits;
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("THE DIAL IS GIVEN SOMEWHERE TO REPORT A DEATH, and a reported death closes the login", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();

    // One dial, live, and it took the mailbox.
    expect(dials.connections).toHaveLength(1);
    expect(dials.current.live).toBe(true);
    expect(b.sidecar.organizerState().organizing).toBe(true);
    expect(meta.appends).toBeGreaterThan(0);

    /* ── THE WIRING ITSELF ───────────────────────────────────────────────────────────────
     *
     * `ImapAdapter` ALWAYS attaches its listeners; what it does not always have is somebody to
     * tell. Before this the engine passed no `onConnectionError` at all, so `guardAsyncErrors`
     * had a handler that called `undefined?.()` and the death went nowhere. Asserting the
     * callback is a FUNCTION is asserting the thing that was missing. */
    expect(typeof dials.current.onConnectionError).toBe("function");

    // ── THE SOCKET DIES, WITH THE PROCESS STILL UP ──────────────────────────────────────
    const died = dials.current;
    died.killFromServer();
    // The close is queued on the mailbox's serial queue — never inline, or it could land under a
    // drain that is mid-batch. Draining the queue is what `syncUntilQuiet` does.
    await b.sidecar.syncUntilQuiet().catch(() => undefined);

    const reports = seen(b, "mailbox_connection_unavailable");
    expect(reports.length, "the death was never reported to the engine").toBeGreaterThan(0);
    expect(reports[0]!.detectedBy).toBe("event");
    /* THE LOGIN WAS ENDED BY US — the invariant, not the call site. A reported death is now
       DESTROYED rather than logged out (see the detector), because a LOGOUT on a link the driver
       still believes in queues behind a hung command, and this one runs on the serial queue every
       drain and every `detach()` take. */
    expect(
      died.forceCloses + died.closes,
      "the dead login was left open for the life of the process",
    ).toBeGreaterThan(0);
    expect(died.closes, "a reported death was asked to log out instead of being destroyed").toBe(0);

    // ── AND THE NEXT DRAIN OPENS A NEW ONE ──────────────────────────────────────────────
    //
    // A SECOND dial, not a re-opened first: an adapter retired by a bound breach refuses every
    // call for ever by design, and a fresh instance is the only shape in which "this install
    // opened a new connection" is observable at all.
    const appendsBefore = meta.appends;
    const cycles = await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);
    expect(dials.connections, "the engine kept polling into the dead socket").toHaveLength(2);
    expect(dials.current.live).toBe(true);
    expect(dials.current).not.toBe(died);
    expect(cycles, "the drain after the re-dial did nothing").toBeGreaterThanOrEqual(1);
    // The claim is being renewed again, which is the fact that decides whether another install
    // becomes entitled to take this mailbox. It is the whole point of healing at all.
    expect(meta.appends, "the organizer claim stopped being renewed").toBeGreaterThan(appendsBefore);
    expect(b.sidecar.organizerState().organizing).toBe(true);
    expect(seen(b, "mailbox_reconnected")).toHaveLength(1);
  }, 60_000);

  /**
   * A REPORTED DEATH ON A LINK THAT IS STILL HALF-OPEN — the phone's own outage, and the
   * teardown that held the queue every cycle runs on.
   *
   * A clean `close` is the desktop's usual outage. A phone that loses its route gets the other
   * shape: the socket deadline fires, imapflow's `emitError` reports it, and the CLIENT STILL
   * BELIEVES IT IS USABLE — so `live` stays true and every command hangs. The detector's
   * teardown runs on the SERIAL QUEUE, and a LOGOUT there queues behind the hung command and
   * never settles.
   *
   * WHAT THAT COSTS IS THE CYCLE, NOT THE DIAL, and the difference is why this case asserts a
   * served cycle at the end. `redialIfDead` runs OUTSIDE the queue, so the heal still opened a
   * fresh connection and still logged `mailbox_reconnected` — while `drainPass` and `detach()`
   * both take the queue and never got it again. A mailbox that reports itself reconnected and
   * organized and files nothing, for ever, is the failure-looks-healthy shape, and it is what a
   * relaunch was the only cure for.
   */
  it("A REPORTED DEATH ON A HALF-OPEN LINK DOES NOT PARK THE QUEUE EVERY CYCLE RUNS ON", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const wedged = dials.current;
    /* After `boot`, so it runs BEFORE the `stop()` boot pushed: a hung command holds the serial
       queue that `stop()` awaits, and a leaked one would hang the suite. */
    cleanups.push(() => wedged.endHangs());
    const afterBoot = dials.connections.length;

    // imapflow's socket deadline, from a client that has not closed: hangs, and reports.
    wedged.goHalfOpen();
    const timedOut = new Error("Socket timeout") as Error & { code: string };
    timedOut.code = "ETIMEOUT";
    wedged.errorFromServer(timedOut);

    expect(
      (await until(b, "mailbox_connection_unavailable", 1)).map((d) => d.detectedBy),
      "the reported death never reached the engine",
    ).toEqual(["event"]);

    /* ── THE MECHANISM ───────────────────────────────────────────────────────────────────── */
    expect(
      wedged.closes,
      "a LOGOUT was issued on a link whose every command hangs — it queues behind the hang and "
      + "never settles, holding the serial queue with it",
    ).toBe(0);
    expect(
      wedged.forceCloses,
      "the wedged connection was never destroyed, so nothing ended the hung command",
    ).toBeGreaterThanOrEqual(1);

    /* Not awaited: with the queue parked this drain never returns, which is the defect — so
       awaiting it would hang the suite instead of failing the assertions below. */
    void b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);

    expect(await untilDials(dials, afterBoot + 1), "nothing re-dialled at all")
      .toBe(afterBoot + 1);
    expect(dials.current, "the engine re-used the dead adapter").not.toBe(wedged);
    expect(dials.current.live, "the replacement connection never came up").toBe(true);
    expect(
      (await until(b, "mailbox_reconnected", 1)).length,
      "the heal was never reported",
    ).toBe(1);

    /* ── AND A CYCLE IS SERVED AGAIN, which is the half a re-dial alone does not buy ─────────
     *
     * `drainPass` takes the serial queue; the heal above does not. So this is the assertion the
     * parked LOGOUT actually fails, and the state it describes is the dangerous one: a mailbox
     * whose settings row says reconnected and organized while nothing is ever filed again.
     * Raced against a bound, because the defect's shape is a promise that never settles. */
    const served = await Promise.race([
      b.sidecar.syncMailbox(b.sidecar.world.mailboxId).then((n) => `cycles:${n}`, (e: unknown) => `threw:${String(e)}`),
      new Promise<string>((r) => { setTimeout(() => r("never returned"), 5_000); }),
    ]);
    expect(
      served,
      "the drain after the heal never came back: the teardown of the dead link is still holding "
      + "the queue every cycle takes, so this mailbox reports itself organized and files nothing",
    ).toMatch(/^cycles:/);

    /* AND THE HEAL IS REPEATABLE. The device's signature was one report and then silence, so a
       second outage healing over a fresh connection is what proves nothing stayed latched. */
    dials.current.killFromServer();
    await b.sidecar.syncUntilQuiet().catch(() => undefined);
    expect(
      await untilDials(dials, afterBoot + 2),
      "the runtime healed once and never again — something stayed latched",
    ).toBe(afterBoot + 2);
  }, 60_000);

  it("NO EVENT, AND IT IS STILL CALLED DEAD — the bound over cycles that actually failed", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    expect(b.sidecar.organizerState().organizing).toBe(true);

    /* ── THE SOCKET GOES WITHOUT A WORD ────────────────────────────────────────────────────
     *
     * No `close`, no `error`, no report — the case `guardAsyncErrors` names in its own comment
     * ("every client with no event surface bypasses this method entirely, which is every fake in
     * the test suite") and the case a real half-open socket produces. If the heal existed only
     * on the listener, everything below would go on failing for ever and nothing would say so. */
    dials.current.dieSilently();
    const dialsBefore = dials.connections.length;

    // Every drain from here throws `LeaseUnavailableError`: `mayOrganize` reads `ohmail/_meta`
    // before anything else happens, and the read is over the socket that is gone.
    /* `syncMailbox` AND NOT `syncUntilQuiet`: the install-level method is
       `Promise.allSettled` over every runtime and reduces a rejection to 0, so a drain that
       failed is indistinguishable there from one that found nothing. The bound is accounted for
       per MAILBOX, which is the level at which a connection exists, and this is the entry point
       that answers for one. */
    const fail = async (): Promise<unknown> =>
      b.sidecar.syncMailbox(b.sidecar.world.mailboxId).then(() => null, (e: unknown) => e);

    for (let i = 1; i < LOCAL_CONNECTION_DEAD_AFTER_CYCLES; i++) {
      const err = await fail();
      expect(err, `cycle ${i} did not fail over the dead socket`).toBeInstanceOf(LeaseUnavailableError);
      expect(
        seen(b, "mailbox_connection_unavailable"),
        `the connection was called dead after ${i} cycles, before the bound`,
      ).toHaveLength(0);
    }

    // ── THE CYCLE THAT CROSSES IT ──────────────────────────────────────────────────────────
    expect(await fail()).toBeInstanceOf(LeaseUnavailableError);
    const reports = seen(b, "mailbox_connection_unavailable");
    expect(reports, "the bound never fired — the wedge is unbounded again").toHaveLength(1);
    expect(reports[0]!.detectedBy, "the death was attributed to an event nobody emitted").toBe("bound");
    /* `op` names WHICH lease operation failed, off the closed union — a fact the CALL SITE
       holds, not a guess at this one. `ensure_meta` and not `list_claims`: the folder is created
       (or SELECTed) before the claims are read, so on a dead socket the FIRST command is the one
       that fails, and the line says so. That distinction is the whole reason `op` is carried —
       "our folder path is wrong for this provider" and "this server will not answer" are
       different faults wearing the same error class. */
    expect(reports[0]!.op).toBe("ensure_meta");
    // NOT the listener's doing: no adapter reported anything, so the count of dials is unmoved.
    expect(dials.connections).toHaveLength(dialsBefore);

    // ── THE HEAL, REACHED BY THE BOUND ALONE ───────────────────────────────────────────────
    //
    // Nothing in this case ever emitted an event. If the re-dial hung off the listener the
    // mailbox would stay wedged here for ever, which is exactly what shipped.
    const cycles = await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);
    expect(dials.connections, "the bound concluded death and nothing acted on it").toHaveLength(dialsBefore + 1);
    expect(dials.current.live).toBe(true);
    expect(cycles).toBeGreaterThanOrEqual(1);
    expect(seen(b, "mailbox_reconnected")).toHaveLength(1);
    expect(b.sidecar.organizerState().organizing).toBe(true);
  }, 60_000);

  /* THE BOUND'S TIME TRIGGER UNDER A WALL CLOCK STEPPED BACK AN HOUR: two failing cycles two
     minutes apart on the monotonic clock call the connection dead, though the wall clock reads an
     hour earlier at the second. The eight-cycle trigger is not what fires here (2 < 8). */
  const timeTrigger = async (stepMs: number, monoMs = LOCAL_CONNECTION_DEAD_AFTER_MS + 1_000): Promise<Array<Record<string, unknown>>> => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const skew = { wall: 0, mono: 0 };
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew.wall);
    cleanups.push(() => { vi.restoreAllMocks(); });
    const b = await boot(await dataDir(), dials, { monotonic: () => performance.now() + skew.mono });
    await b.sidecar.start();
    expect(b.sidecar.organizerState().organizing).toBe(true);
    dials.current.dieSilently();
    const fail = (): Promise<unknown> =>
      b.sidecar.syncMailbox(b.sidecar.world.mailboxId).then(() => null, (e: unknown) => e);
    expect(await fail()).toBeInstanceOf(LeaseUnavailableError);
    expect(seen(b, "mailbox_connection_unavailable"), "called dead on the first failure").toHaveLength(0);
    skew.mono += monoMs;
    skew.wall += LOCAL_CONNECTION_DEAD_AFTER_MS + 1_000 - stepMs;
    expect(await fail()).toBeInstanceOf(LeaseUnavailableError);
    return seen(b, "mailbox_connection_unavailable");
  };

  it("THE BOUND'S TIME TRIGGER FIRES ACROSS A WALL CLOCK STEPPED BACK AN HOUR", async () => {
    const reports = await timeTrigger(HOUR);
    expect(reports, "the time trigger read the clock's step and waited for the cycle count").toHaveLength(1);
    expect(reports[0]!.detectedBy).toBe("bound");
  }, 60_000);

  it("THE BOUND'S TIME TRIGGER FIRES ACROSS A SUSPEND (wall past the bound, monotonic +1 s)", async () => {
    const reports = await timeTrigger(0, 1_000);
    expect(reports, "the suspend did not count toward the bound").toHaveLength(1);
    expect(reports[0]!.detectedBy).toBe("bound");
  }, 60_000);

  it("CONTROL: with no step the time trigger fires after its bound", async () => {
    const reports = await timeTrigger(0);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.detectedBy).toBe("bound");
  }, 60_000);

  /**
   * ── THE ENGINE WRITES ITS OWN MEMORY DOWN, AND KEEPS DOING IT, AND THEN STOPS ────────────
   *
   * The first half of a question this repository has never been able to answer: nothing in it
   * has ever called `memoryUsage()`, and the only figure that exists for this engine came from a
   * throwaway build. What ships here is the INSTRUMENT — no threshold, no warning arm — because a
   * bar chosen before the first measurement is a number somebody invented, and every later
   * reading would be judged against it rather than against reality.
   *
   * Three properties, because two of them are how instrumentation silently dies: a sample at boot
   * (a launch killed early still leaves a floor on the record, and the series needs a zero point
   * to measure drift from), a sample per interval after it, and an interval that ENDS with the
   * engine. The last one is not tidiness here — an interval outliving its engine holds a logger
   * closure, and two engines in one test process would interleave readings under one event name.
   */
  it("SAMPLES ITS OWN MEMORY at boot, on the interval, and stops with the engine", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const dir = await dataDir();
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine being measured",
      pollIntervalMs: 60 * HOUR,
      /* THE SEAM. The shipped interval is five minutes; a guard that proved the timer by waiting
         for it would take five minutes to fail, which is a guard nobody runs. */
      vitalsIntervalMs: 30,
      adapterFactory: dials.factory,
      log: (event, detail) => { events.push({ event, detail }); },
    });
    const vitals = (): Array<Record<string, unknown>> =>
      events.filter((e) => e.event === "engine_vitals").map((e) => e.detail);

    // ── AT BOOT, BEFORE ANYTHING IS DIALLED ────────────────────────────────────────────────
    expect(vitals(), "a launch killed early would leave no figure at all").toHaveLength(1);
    const first = vitals()[0]!;
    /* THREE NUMBERS AND NOT ONE. This process keeps a DATABASE outside the JavaScript heap — a
       WASM heap `heapUsed` cannot see and `external` can — so `heapUsed` alone describes a
       fraction of the process and `rss` alone cannot say which half grew. */
    expect(typeof first.rss).toBe("number");
    expect(typeof first.heapUsed).toBe("number");
    expect(typeof first.external).toBe("number");
    /* AND THE TWO THAT MAKE A STEP ATTRIBUTABLE. A measured idle install rose 95 MB in `rss` while
       `heapUsed` FELL: what the heap had RESERVED and what the buffers behind the store weighed
       were the two readings that would have named it, and the line carried neither. */
    expect(typeof first.heapTotal, "the line no longer says what the heap has reserved").toBe("number");
    expect(typeof first.arrayBuffers, "the line no longer says what the buffers weigh").toBe("number");
    expect(first.heapTotal as number).toBeGreaterThanOrEqual(first.heapUsed as number);
    expect(first.rss as number, "the reading is not a real measurement").toBeGreaterThan(0);
    /* AND THE STORE'S OWN HEAP, which is the one number that makes a rise in `rss` attributable:
       the mirror is a WebAssembly Postgres whose heap sits outside the JavaScript heap, so
       `heapUsed` cannot see it and `external` cannot separate it from anything else. Wired from
       the open handle in the constructor, so a line without it means the wiring is gone, not that
       the store is empty. */
    expect(typeof first.storeBytes, "the line no longer names the store's own heap").toBe("number");
    expect(first.storeBytes as number, "the store reported no heap — the field is not a measurement")
      .toBeGreaterThan(0);
    // The x-axis. Without it a sequence of readings has no series and answers no drift question.
    expect(typeof first.uptimeMs).toBe("number");

    // ── AND AGAIN, ON THE TIMER ────────────────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 120));
    expect(vitals().length, "the sample at boot was the only one there will ever be")
      .toBeGreaterThan(1);

    // ── AND IT ENDS WITH THE ENGINE ────────────────────────────────────────────────────────
    await sidecar.stop();
    const atStop = vitals().length;
    await new Promise((r) => setTimeout(r, 120));
    expect(vitals().length, "the sampler outlived the engine it measures").toBe(atStop);
  }, 60_000);

  it("A CLAIM THAT ARRIVED DURING THE OUTAGE IS HONOURED ON THE FIRST CYCLE BACK", async () => {
    const meta = new MemoryMetaFolder();
    /* MAIL IS WAITING ON THE WAY BACK. Without it `move` is never called whatever role the drain
       runs under, and the assertion below would pass over a re-dial that skipped the gate
       entirely — which is what a first version of this case did. */
    const dials = dialLog(meta, [101, 102]);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    expect(b.sidecar.organizerState().organizing).toBe(true);
    const launched = dials.current;
    expect(launched.folderBuilds, "the launch did not build the tree it organizes into").toBeGreaterThan(0);

    // ── THE SOCKET DIES ────────────────────────────────────────────────────────────────────
    //
    // No drain in between, deliberately: the claim below has to be in the folder BEFORE the
    // first cycle back, or the re-dial this case judges is a re-dial that happened while the
    // mailbox was still ours and proves nothing about the gate.
    launched.killFromServer();

    /* ── AND SOMEBODY ELSE TAKES THE MAILBOX WHILE WE CANNOT SEE ────────────────────────────
     *
     * This is the case reconnect exists to get right and the one it is most likely to get
     * wrong. Reconnect-after-sleep is precisely when a mailbox has most probably changed hands:
     * the laptop was shut, the person opened their mail somewhere else, and a fresh claim is
     * sitting in `ohmail/_meta`. A re-dial that resumed the drain over the new socket without
     * re-reading the lease would organize for one whole cycle against that claim — two writers
     * in one mailbox, which is the invariant this product is built on.
     *
     * The claim carries a PRESS (`authorizedAt`), because that is the only way a live incumbent
     * loses a mailbox: somebody asked for it explicitly. A claim without one models an install
     * that arrived and lost, which is a different scenario and not this one. */
    await meta.appendClaim(formatClaim({
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "arrived-during-the-outage",
      authorizedAt: new Date(), capabilities: ["requests"],
    }));
    const appendsAfterForeign = meta.appends;

    // ── THE FIRST CYCLE BACK ───────────────────────────────────────────────────────────────
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);
    expect(dials.connections, "no re-dial happened, so this case proves nothing").toHaveLength(2);
    const reopened = dials.current;
    expect(reopened.live).toBe(true);

    expect(
      b.sidecar.organizerState(),
      "the re-dialled install went on organizing a mailbox somebody else had claimed",
    ).toMatchObject({ organizing: false, reason: "organized_elsewhere:cloud" });

    /* THE IMAP WRITES, WHICH ARE THE ACTUAL DAMAGE. `ensureFolders` is the one this ordering
       protects — it CREATES the `ohmail/*` tree in somebody else's mailbox — and `move` is the
       filing a second organizer would perform. Counted on the RE-OPENED connection, so the
       launch's own legitimate tree-build does not mask a re-dial that repeated it. */
    expect(reopened.folderBuilds, "the re-dial created folders before it read the lease").toBe(0);
    expect(reopened.moves, "the re-dial filed mail against a foreign claim").toBe(0);
    // AND NO CLAIM OF OUR OWN. Standing down is a decision about the mailbox, not only about
    // this process: a claim appended here would outlive the process and invite a fight.
    expect(meta.appends, "this install appended a claim over a fresh foreign one").toBe(appendsAfterForeign);
  }, 60_000);

  /**
   * ══ THE RACE THE GENERATION EXISTS FOR ═══════════════════════════════════════════════════
   *
   * A drain reads the organizer lease ONCE, on ONE connection, and everything it does afterwards
   * rests on that read. If the connection is replaced while it is running, every later step is
   * happening on a connection whose lease it never read — and reconnect-after-sleep is exactly
   * when a mailbox has most likely changed hands.
   *
   * The sequence: a drain is parked mid-cycle on connection A, holding the queue. The socket
   * dies, a stranger claims the mailbox, and another caller re-dials to B. The re-dial's own
   * gate cannot run yet (the queue is held), so for a moment B is live, ungated, and the binding
   * every cycle reads. THAT is the window, and the drain must not file anything through it.
   *
   * ── TWO MECHANISMS, AND DO NOT DELETE THE QUIET ONE ──────────────────────────────────────
   *
   * `engine.ts` protects this twice: the drain PINS the adapter instance it gated on (spread over
   * `syncDeps`'s live getter for every cycle), and it re-checks the connection GENERATION at every
   * cycle edge. The pin is unobservable from this case on its own, and that is not evidence that
   * it is redundant. The three mutations, measured:
   *
   *   · the cycle-edge refusal deleted  → RED: "expected Error: Connection not available to be an
   *     instance of ConnectionReplacedError". The pin still held the line — `moves` on the new
   *     connection stayed 0 — but the NAMED refusal was lost and the pass died on the closed
   *     connection instead;
   *   · BOTH deleted                    → RED: "a drain gated on the old connection filed mail on
   *     the new one: expected 2 to be 0". Two of a stranger's messages filed. This is the defect;
   *   · the pin alone deleted           → GREEN, because the edge refusal fires first and the
   *     drain never reaches the writes.
   *
   * So the pin protects the WITHIN-CYCLE window, which the edge check cannot reach: the edge only
   * runs BETWEEN cycles, and a swap that lands mid-cycle has a whole cycle of writes ahead of it.
   * A guard that is unobservable only because a stronger one pre-empts it is still a guard.
   * Deleting it because this case stays green would remove real protection and leave nothing at
   * all covering the gap the middle mutation exposes.
   *
   * ── AND THE FIXTURE IS LOAD-BEARING ──────────────────────────────────────────────────────
   *
   * The parked connection reports `hasBacklog`, which makes the drain run a SECOND cycle. Without
   * it the drain ran exactly one, the swap never landed between two cycles, the window was never
   * entered — and this case passed with the protection deleted, in every combination. A race test
   * that cannot reach the race is not a guard, it is a decoration.
   */
  it("A DRAIN GATED ON ONE CONNECTION NEVER FILES ON THE NEXT ONE", async () => {
    const meta = new MemoryMetaFolder();
    let entered!: () => void;
    const arrived = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const park = { armed: false, entered, wait: held };
    /* THE NEW CONNECTION HAS MAIL WAITING TOO, and without it this case proves nothing.
     *
     * The cycle asks whichever adapter its deps hold. Pinned, that is the parked connection, and
     * the mail it hands back cannot be filed because that connection is closed. UNPINNED — which
     * is the defect — the cycle asks the NEW connection instead, so unless the new one also has
     * mail there is nothing for the bug to file and the case passes over it. Measured: with the
     * pin removed and no mail here, this test stayed green. */
    const dials = dialLog(meta, [301, 302], park);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    expect(b.sidecar.organizerState().organizing).toBe(true);
    const gatedOn = dials.current;
    park.armed = true;                 // only now — the boot's own drain must not be parked

    // ── A DRAIN IS PARKED MID-CYCLE, HOLDING THE QUEUE ──────────────────────────────────────
    const parkedDrain = b.sidecar.syncMailbox(b.sidecar.world.mailboxId)
      .then(() => null, (e: unknown) => e);
    await arrived;

    // ── THE SOCKET DIES AND A STRANGER TAKES THE MAILBOX ────────────────────────────────────
    gatedOn.killFromServer();
    await meta.appendClaim(formatClaim({
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "arrived-mid-drain",
      authorizedAt: new Date(), capabilities: ["requests"],
    }));

    /* ── ANOTHER CALLER RE-DIALS. Its gate queues behind the parked drain; the SWAP does not. ─ */
    const second = b.sidecar.syncMailbox(b.sidecar.world.mailboxId)
      .then(() => null, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    expect(dials.connections.length, "no second connection was opened — the race is not set up")
      .toBe(2);
    const reopened = dials.current;
    expect(reopened).not.toBe(gatedOn);

    // ── THE PARKED DRAIN IS LET GO ──────────────────────────────────────────────────────────
    release();
    const outcome = await parkedDrain;
    await second;

    /* THE WHOLE POINT. Two of a stranger's messages were waiting; the drain that was gated on A
       must not have filed either of them through B. Counted on the RE-OPENED connection, so the
       launch's own legitimate work cannot mask it. */
    expect(reopened.moves, "a drain gated on the old connection filed mail on the new one").toBe(0);
    expect(reopened.folderBuilds, "it created folders on a connection it never gated").toBe(0);
    /* AND NOTHING REACHED THE SERVER AT ALL through the stale pass: the mail it was holding was
       filed on neither connection. The pinned `adapter` is what makes that true — the pipeline
       wrote to the connection whose lease it read, which was already closed, so the writes
       failed instead of landing somewhere they had no right to.

       `outcome` is deliberately NOT asserted non-null. Whether the stale pass ends by REFUSING
       (`ConnectionReplacedError`, raised at the next cycle edge) or by simply failing its writes
       against the closed connection depends on how far the pipeline gets before the batch is
       abandoned, and both are correct endings — the property under test is where the mail went,
       not which of two right answers the pass returned. Asserting the refusal here would be
       asserting an implementation detail of the pipeline's error handling. */
    /* AND IT ABANDONED ITSELF BY NAME. The parked drain was handed a backlog, so it reaches a
       SECOND cycle — and the swap happened between the two, which is the window. The refusal is
       raised at that edge and carries a code, so a caller can tell a stale pass from a real
       fault without reading a message. */
    expect(outcome, "the stale pass ran on to a second cycle instead of abandoning itself")
      .toBeInstanceOf(ConnectionReplacedError);
    expect((outcome as ConnectionReplacedError).code).toBe("ECONNGEN");
    expect(gatedOn.moves, "the stale pass filed mail over a connection it had already lost")
      .toBe(0);
    // The mailbox is somebody else's now, and this install knows it.
    expect(b.sidecar.organizerState()).toMatchObject({ organizing: false });
  }, 60_000);

  /**
   * A LATE `error` FROM A CONNECTION WE ALREADY REPLACED MUST NOT KILL ITS REPLACEMENT.
   *
   * The real adapter's `error` listener is UNCONDITIONAL — only `close` is guarded by
   * `closing`/`established` — so a socket we deliberately closed during a re-dial is entitled to
   * report an error afterwards. The double models that faithfully now; it did not before, and
   * that generosity is what hid this.
   */
  it("A DEATH REPORTED BY A CONNECTION WE ALREADY REPLACED IS NOT ACTED ON", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const first = dials.current;

    first.killFromServer();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);
    expect(dials.connections).toHaveLength(2);
    const live = dials.current;
    expect(live.live).toBe(true);
    const deathsBefore = seen(b, "mailbox_connection_unavailable").length;
    const closesBefore = live.closes;

    // ── THE OLD SOCKET SPEAKS UP, AFTER ITS REPLACEMENT IS UP AND GATED ─────────────────────
    first.errorFromServer(new Error("ECONNRESET from the socket we already abandoned"));
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);

    expect(seen(b, "mailbox_connection_unavailable").length,
      "a dead connection's late report marked its healthy replacement dead").toBe(deathsBefore);
    expect(live.closes, "the queued close retired the replacement instead of the corpse")
      .toBe(closesBefore);
    expect(live.live, "the live connection was torn down by a stale report").toBe(true);
    expect(dials.connections, "it re-dialled over a connection that never failed").toHaveLength(2);
    // It is not silent, either: the report is recorded, it is simply not acted on.
    expect(seen(b, "mailbox_connection_stale_report").length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * A RE-DIAL THAT LANDS AFTER `detach()` MUST NOT INSTALL A CONNECTION.
   *
   * `detach()` sets `stopped`, waits for the queue and closes the login. A re-dial is not in the
   * queue — it cannot be, or it would wait for itself — so without its own wait and its own
   * re-checks it resumes AFTERWARDS and renews an organizer claim, creates folders, or leaves an
   * authenticated login for a mailbox that has been removed.
   */
  it("A RE-DIAL SUSPENDED ACROSS detach() STOPS INSTEAD OF INSTALLING A CONNECTION", async () => {
    const meta = new MemoryMetaFolder();
    let entered!: () => void;
    const dialling = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const dials = dialLog(meta, [], undefined, { park: { entered, wait: held } });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();

    dials.current.killFromServer();
    const redialling = b.sidecar.syncMailbox(b.sidecar.world.mailboxId)
      .then(() => null, (e: unknown) => e);
    await dialling;                       // parked inside the re-dial's own connect()
    const appendsBefore = meta.appends;

    // ── THE MAILBOX GOES WHILE THE DIAL IS IN FLIGHT ───────────────────────────────────────
    let detached = false;
    const stopping = b.sidecar.stop().then(() => { detached = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(detached, "teardown finished while a re-dial was still in flight").toBe(false);

    release();
    await stopping;
    await redialling;

    expect(detached).toBe(true);
    expect(meta.appends, "a detached runtime renewed its organizer claim").toBe(appendsBefore);
    expect(dials.current.folderBuilds, "a detached runtime created folders").toBe(0);
    expect(dials.current.live, "a detached runtime left an authenticated login open").toBe(false);
  }, 60_000);

  /**
   * THE BOUND HAS TO WORK FOR A READER, WHICH IS THE ROLE IT DID NOT COVER.
   *
   * An organizer's drain reads `ohmail/_meta` first, so a dead socket surfaces as
   * `LeaseUnavailableError` and the old class test caught it. A reader's gate takes the
   * append-less peek, which never throws by design — so its failure arrives as an ordinary
   * adapter error, the bound counted nothing, and its mirror froze until the process restarted
   * with the pane still reporting the mailbox reachable.
   */
  it("THE BOUND FIRES FOR A READER TOO — its failures are not lease failures", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta, [201, 202]);
    const b = await boot(await dataDir(), dials);
    /* SOMEBODY ELSE HOLDS THE MAILBOX, so this install is a reader from its first pass. */
    await meta.appendClaim(formatClaim({
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "the-holder",
      authorizedAt: new Date(), capabilities: ["requests"],
    }));
    await b.sidecar.start();
    expect(b.sidecar.organizerState().organizing, "this case needs a READER").toBe(false);

    dials.current.dieSilently();
    const dialsBefore = dials.connections.length;
    for (let i = 0; i < LOCAL_CONNECTION_DEAD_AFTER_CYCLES; i++) {
      await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    }
    const reports = seen(b, "mailbox_connection_unavailable");
    expect(reports.length, "a reader's dead socket advanced neither arm of the bound")
      .toBeGreaterThan(0);
    expect(reports[0]!.detectedBy).toBe("bound");
    // The bound MARKS on the cycle that crosses it; the re-dial is the next pass's first act.
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect(dials.connections.length, "the bound fired and nothing re-dialled")
      .toBeGreaterThan(dialsBefore);
  }, 60_000);

  /**
   * A LIVE SERVER AND AN UNREADABLE LEASE IS NOT A RECONNECTION.
   *
   * `dialAndGate` returns normally when it cannot read `ohmail/_meta` — offline is a property of
   * this mode and an unreachable lease must leave a usable app. The re-dial used to read that as
   * success: it cleared the outage, logged `mailbox_reconnected`, and reported the mailbox
   * healthy while nothing was being filed — throwing away the true age of the outage on the way.
   */
  it("A RE-DIAL ONTO A LIVE SERVER WITH AN UNREADABLE LEASE IS NOT REPORTED AS RECOVERY", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const rt = () => b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!;
    expect(rt().reachable).toBe(true);

    /* THE FOLDER GOES FIRST, so the re-dial below is the one that meets it. Reading the clock
       before any drain runs is deliberate: a drain would heal the outage and there would be
       nothing left to assert about. */
    meta.unreadable = true;
    dials.current.killFromServer();
    const outageStart = rt().unreachableSince;
    expect(outageStart, "the death was never recorded").not.toBeNull();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);

    expect(dials.current.live, "this case needs a LIVE socket to mean anything").toBe(true);
    expect(seen(b, "mailbox_reconnected"),
      "a re-dial that organizes nothing was announced as a recovery").toHaveLength(0);
    expect(seen(b, "mailbox_reconnect_lease_unavailable").length).toBeGreaterThan(0);
    expect(rt().reachable, "the pane reported a mailbox nothing is filing as reachable").toBe(false);
    expect(rt().unreachableSince, "the outage clock was restarted by a partial recovery")
      .toEqual(outageStart);
  }, 60_000);

  /**
   * ══ AND QUITTING THERE GIVES THE CLAIM BACK ════════════════════════════════════════════════
   *
   * The state above is `claimed` true with `organizing` false: this install's claim is standing in
   * `ohmail/_meta` and the lease cannot be read to renew it. The stop's release asked `organizing`,
   * so it did nothing here — the claim was left to age out and obstructed every other install for
   * a staleness window, over a machine the person had just quit. It asks `claimed` now, which is
   * the field that means "a claim of ours may be in the folder".
   *
   * MUTATION WATCHED RED: put that predicate back to `organizer.organizing` and the claim survives
   * the stop.
   */
  it("A STOP WITH AN UNREADABLE LEASE STILL HANDS THIS INSTALL'S CLAIM BACK", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    /* THE PRECONDITION: a claim of ours is really in the folder, so a zero at the end is a
       release and not an empty folder that was always empty. */
    expect(await meta.listClaims(), "the gate never claimed, so this case is about nothing")
      .toHaveLength(1);
    expect(b.sidecar.organizerState().organizing).toBe(true);

    /* INTO THE WINDOW — the sibling above's own sequence, which ends with `claimed` standing and
       `organizing` withdrawn. */
    meta.unreadable = true;
    dials.current.killFromServer();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    const inWindow = b.sidecar.organizerState();
    expect(inWindow.organizing, "the window is not set up — this install still declares").toBe(false);
    expect(inWindow.claimed, "the window is not set up — the claim was already given up").toBe(true);

    /* THE FOLDER READS AGAIN — the stop needs it to address what it wrote, and the point is that
       the RELEASE happens, not that it happens blind. */
    meta.unreadable = false;
    await b.sidecar.stop();
    expect(await meta.listClaims(),
      "the person quit and this install's claim stayed in ohmail/_meta to age out")
      .toHaveLength(0);
  }, 60_000);

  /**
   * THE BOUND COUNTS CONNECTION FAILURES, NOT EVERY FAILURE — and a stopped drain is neither.
   */
  it("AN UNRELATED FAILURE DOES NOT ARM THE BOUND", () => {
    const storeFault = new Error("could not write the message row");
    expect(isConnectionFailure(storeFault),
      "an unrelated defect would re-dial a healthy connection").toBe(false);
    expect(isConnectionFailure(new ConnectionReplacedError(1, 2)),
      "our own staleness refusal would arm the bound toward the next re-dial").toBe(false);
    // …and the ones that ARE the connection, including the wrapped and the coded shapes.
    const noConn = Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    expect(isConnectionFailure(noConn)).toBe(true);
    expect(isConnectionFailure(new Error("x", { cause: noConn })),
      "a driver error wrapped by a caller stopped counting").toBe(true);
  });

  /**
   * A LAUNCH THAT COULD NOT DIAL AT ALL IS AN OUTAGE, NOT A HEALTHY MAILBOX.
   *
   * `connect()` can reject with nothing ever emitted — a refused TCP connection, a TLS failure, a
   * server that never greets. No detector fired, and `start()` threw before arming the poll, so
   * the mailbox was reported REACHABLE for ever with no path that could heal it.
   */
  it("A FAILED FIRST DIAL IS REPORTED UNREACHABLE, AND STILL GETS A POLL", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    // The FIRST dial fails: replace the connection before `start()` reaches it.
    dials.current.failNextConnect = new Error("ECONNREFUSED");
    await b.sidecar.start();          // the install logs a failed mailbox and serves the mirror

    const state = b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!;
    expect(state.reachable, "a mailbox that never connected was reported reachable").toBe(false);
    expect(state.unreachableSince).not.toBeNull();
    // AND IT CAN HEAL: the poll exists, so a later drain re-dials rather than waiting for a quit.
    dials.current.failNextConnect = null;
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect(dials.connections.length, "there was no path back from a failed first dial")
      .toBeGreaterThan(1);
  }, 60_000);

  /**
   * ══ AND IT DOES NOT CLAIM TO ORGANIZE A MAILBOX IT NEVER ASKED THE LEASE ABOUT ═════════════
   *
   * The runtime attached `organizing: true` from the ROW's memory, and the mask over the mechanism
   * can only WITHHOLD what a pass declared — so on this path, where the dial is refused, the death
   * is recorded, the poll timer IS armed and the gate never runs, every term of the mask read true
   * and the pane said this install organizes the mailbox. Nothing had asked. `organizing` is a
   * pass's declaration now and only the gate makes one; `claimed` is the ROW's instruction and is
   * untouched, which is what keeps a just-claimed install from reading as a reader.
   *
   * MUTATION WATCHED RED: put the attach default back to `organizing: true` and the first
   * assertion fails while the connection assertions beside it stay green.
   */
  it("A FAILED FIRST DIAL LEAVES NO ORGANIZING CLAIM STANDING", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    dials.current.failNextConnect = new Error("ECONNREFUSED");
    await b.sidecar.start();

    /* THE PRECONDITION, so a green here cannot be "the gate ran and stood down": the folder is
       empty, so a gate that HAD run would have claimed the mailbox and organized it. */
    expect(await meta.listClaims(), "a claim exists, so the gate ran and this case is about nothing")
      .toHaveLength(0);
    const state = b.sidecar.organizerState();
    expect(state.organizing, "an install that never reached the lease reported itself organizing")
      .toBe(false);
    expect(state.claimed, "the row's own instruction was dropped with the declaration").toBe(true);
    expect(state.reason, "a refused dial was rendered as an organizer verdict").toBeNull();

    /* AND THE GATE STILL GRANTS IT. A default that can never be turned on is the same defect
       pointing the other way: the dial succeeds, the pass declares, and the pane says so. */
    dials.current.failNextConnect = null;
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect(b.sidecar.organizerState().organizing,
      "no pass could turn the declaration on again").toBe(true);
  }, 60_000);


  /**
   * ══ THE POST-DRAIN WRITES, WHICH THE CYCLE GUARD NEVER REACHED ═══════════════════════════
   *
   * A drain does not end when its cycles do. After the loop it drives the REQUEST CHANNEL —
   * appending, acknowledging and expunging decisions in `ohmail/_meta` — and publishes the
   * portable profile into the same folder. Both used to read the mutable binding, so a pass that
   * gated connection A and reached that block after a re-dial installed B did its `_meta` writes
   * on B, whose own gate was still queued behind this very pass.
   *
   * Two installs writing one mailbox's decisions, with every cycle behaving perfectly. The first
   * round's fix guarded the cycles and left this, and no behavioural test could see it because
   * the double exposed none of the three IO surfaces the real adapter has.
   *
   * A ONE-CYCLE pass, deliberately: `hasBacklog` false, so the loop exits after one cycle and the
   * post-drain block is the very next thing that runs. The two-cycle case above aborts at a cycle
   * edge and never reaches here.
   */
  it("A STALE PASS DOES NO REQUEST OR PROFILE WRITES ON THE CONNECTION THAT REPLACED IT", async () => {
    const meta = new MemoryMetaFolder();
    let entered!: () => void;
    const arrived = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const park = { armed: false, entered, wait: held };
    const dials = dialLog(meta, [], park, undefined, { oneCycle: true });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    expect(b.sidecar.organizerState().organizing).toBe(true);
    const gatedOn = dials.current;
    park.armed = true;

    // A pass is parked inside its ONLY cycle, holding the queue.
    const stale = b.sidecar.syncMailbox(b.sidecar.world.mailboxId)
      .then(() => null, (e: unknown) => e);
    await arrived;

    // The socket dies, a stranger takes the mailbox, and another caller re-dials.
    gatedOn.killFromServer();
    await meta.appendClaim(formatClaim({
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "took-it-mid-pass",
      authorizedAt: new Date(), capabilities: ["requests"],
    }));
    const second = b.sidecar.syncMailbox(b.sidecar.world.mailboxId)
      .then(() => null, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    expect(dials.connections, "the race is not set up — no replacement was dialled").toHaveLength(2);
    const reopened = dials.current;

    release();
    const outcome = await stale;
    await second;

    /* ── THE ARM THAT ACTUALLY FIRES, and it is worth saying which one ────────────────────
     *
     * The pass is REFUSED before it reaches the post-drain block. Measured both ways: with the
     * guards in place this is a `ConnectionReplacedError`; with the three post-drain assertions
     * deleted the same pass returns a successful cycle count — having run the request channel and
     * the profile publish through the connection that replaced it.
     *
     * The counter assertions below cannot fire on their own in this fixture, and that is stated
     * rather than hidden: with an empty `_meta` there is nothing for the request drain to
     * acknowledge and nothing for the profile write-behind to flush, so every counter is zero
     * whether the code is right or wrong. They are here to pin the SHAPE — that a stale pass
     * touches none of the five surfaces — and the refusal above is what a regression trips over.
     * The exhaustive guard for the other direction is `connection-write-census.test.ts`, which
     * fails if any surface loses its pin or its assertion. */
    expect(
      outcome,
      "the stale pass ran on into the request channel and the profile publish instead of "
      + "abandoning itself — those writes land on the connection that replaced it",
    ).toBeInstanceOf(ConnectionReplacedError);

    /* THE WHOLE POINT: the replacement took none of the stale pass's `_meta` writes. Counted on
       the REOPENED connection, so the legitimate work of its own gated pass cannot mask it. */
    expect(reopened.requestAppends, "a stale pass appended a decision through the replacement")
      .toBe(0);
    expect(reopened.requestAcks, "a stale pass acknowledged a decision through the replacement")
      .toBe(0);
    expect(reopened.requestRemovals, "a stale pass expunged a decision through the replacement")
      .toBe(0);
    expect(reopened.profileAppends, "a stale pass published the profile through the replacement")
      .toBe(0);
    expect(reopened.profileRemovals, "a stale pass expunged a profile through the replacement")
      .toBe(0);
    // And it did not file or build folders there either.
    expect(reopened.moves).toBe(0);
    expect(reopened.folderBuilds).toBe(0);
  }, 60_000);


  /**
   * A SERVER THAT ANSWERS AND REFUSES THE SIGN-IN IS NOT RETRIED, AND IS NOT MISDESCRIBED.
   *
   * The poll is fifteen seconds, and every poll built a fresh adapter and dialled again — FOUR
   * LOGIN ATTEMPTS A MINUTE at a server that had already said no. Providers throttle that and
   * some lock the account, so the app turns a wrong password into a lost mailbox. Meanwhile the
   * pane said "Can't reach the mail server", sending the person to look at a network that was
   * working perfectly: the server had been reached, and it had answered.
   */
  it("A REFUSED SIGN-IN STOPS THE RE-DIAL, and says so instead of blaming the network", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    /* imapflow's own flag for "the LOGIN command did not succeed" — the signal the worker's
       taxonomy keys on, so the two cannot disagree about the one case they both judge. */
    const refusal = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    dials.current.failNextConnect = refusal;
    await b.sidecar.start();

    const state = () => b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!;
    expect(state().signInRefused, "a refused sign-in was not recognised as one").toBe(true);
    expect(state().reachable).toBe(false);
    expect(seen(b, "mailbox_sign_in_failed").length).toBeGreaterThan(0);

    // ── AND IT DOES NOT KEEP KNOCKING ──────────────────────────────────────────────────────
    const dialsAfterLaunch = dials.connections.length;
    for (let i = 0; i < 5; i++) {
      await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    }
    expect(
      dials.connections.length,
      "five polls produced five more LOGIN attempts at a server that already refused",
    ).toBe(dialsAfterLaunch);
  }, 60_000);

  /**
   * A RE-DIAL WHOSE GATE SUCCEEDS AFTER `detach()` BEGAN MUST GIVE THE MAILBOX BACK.
   *
   * `detach()` sets `stopped`, waits for the queue, and closes the login — and the post-gate
   * check read `if (!permitted && stopped)`, so a gate that said YES walked straight past it. The
   * lease read is the longest await in the sequence, which makes it the likeliest place for a
   * removal to land; the pass then continued into `ensureFolders`, discovery and a full drain on
   * a runtime that had been told it was finished, having already renewed its claim on the way
   * through. `detach()` waited for all of that. It bounded the damage and prevented none of it.
   */
  it("A GATE THAT SUCCEEDS AFTER detach() STANDS DOWN INSTEAD OF ORGANIZING", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();

    // The re-dial's gate parks INSIDE the lease read — the window this case is about.
    let entered!: () => void;
    const reading = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    meta.parkRead = { entered, wait: held };

    const redial = b.sidecar.syncMailbox(b.sidecar.world.mailboxId)
      .then(() => null, (e: unknown) => e);
    await reading;
    const buildsBefore = dials.current.folderBuilds;

    // The mailbox goes while the gate is mid-read.
    const stopping = b.sidecar.stop();
    await new Promise((r) => setTimeout(r, 30));
    release();
    await stopping;
    await redial;

    expect(
      dials.current.folderBuilds,
      "a runtime that had been told to stop went on to create folders in the mailbox",
    ).toBe(buildsBefore);
    /* AND THE CLAIM IT RENEWED MID-READ IS GIVEN BACK. The folder ends with the claim count it
       started with rather than one this install is no longer honouring, so the next install takes
       the mailbox at once instead of waiting out a stale claim. */
    expect(meta.count, "a detached install left its organizer claim behind").toBe(0);

    /* ── AND THE LINE THAT SAYS SO COUNTS WHAT IT GAVE BACK ──────────────────────────────────
     *
     * `organizer_claim_released_on_detach` was written UNCONDITIONALLY, with the release's answer
     * discarded — so a pass that removed nothing still reported the claim "given back rather than
     * left to age out", which is the opposite of what had happened. Its two siblings on this door
     * both gate on the count; this arm is the one a person's removal actually triggers, so it is
     * the one whose sentence gets read when somebody is working out why another machine will not
     * take the mailbox.
     *
     * Asserted on `claims` rather than on the line's presence, because presence alone is what the
     * unconditional version also produced. A count is the thing only a real release can supply. */
    const givenBack = seen(b, "organizer_claim_released_on_detach");
    expect(givenBack.length, "the detach released a claim and said nothing about it").toBe(1);
    expect(givenBack[0]!.claims, "the detach reported a release without a count of what it removed")
      .toBe(1);
  }, 60_000);


  /**
   * A CYCLE THAT SERVED ENDS THE OUTAGE, EVEN IF ITS DRAIN LATER FAILS.
   *
   * The bound was recorded once around the whole drain, and a drain is up to its cycle ceiling. So
   * a flapping socket produced this: seven drains fail; the socket recovers; a backlog drain
   * serves a real cycle — clearing nothing, because the drain had not finished; the socket dies
   * again on a later inner cycle; the drain rejects and the streak advances 7 → 8, declaring the
   * connection dead at once. The served cycle should have ended the old outage and the new
   * failure should have been streak one.
   */
  it("A SERVED CYCLE CLEARS THE STREAK, even when its own drain fails afterwards", async () => {
    const meta = new MemoryMetaFolder();
    const flap = { armed: false };
    const dials = dialLog(meta, [], undefined, undefined, { dieAfterFirstCycle: flap });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();

    /* SEVEN FAILURES: one short of the bound. The socket is silently gone, so every drain fails
       on the lease read without a single cycle running. */
    dials.current.dieSilently();
    for (let i = 0; i < LOCAL_CONNECTION_DEAD_AFTER_CYCLES - 1; i++) {
      await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    }
    expect(seen(b, "mailbox_connection_unavailable"), "the bound fired early").toHaveLength(0);

    /* THE SOCKET COMES BACK, and the next drain serves a cycle and THEN loses it again — which is
       the flap. Under whole-drain accounting this is failure number eight. */
    dials.current.live = true;
    flap.armed = true;
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);

    expect(
      seen(b, "mailbox_connection_unavailable"),
      "a cycle that served did not end the old outage, so an unrelated later failure was counted "
      + "as the eighth in a row and the connection was declared dead on the spot",
    ).toHaveLength(0);
  }, 60_000);

  /**
   * THE POLL ITSELF RE-DIALS — observed, not simulated.
   *
   * The earlier version of this case called `syncMailbox` by hand, so deleting `schedule()` from
   * the failed-dial path left it green: it proved the re-dial works when something asks for it,
   * not that anything asks. The timer is the whole claim — a mailbox whose first dial failed has
   * no other way back.
   */
  it("A FAILED FIRST DIAL IS RETRIED BY THE TIMER, with nobody calling sync", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const dir = await dataDir();
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine whose first dial failed",
      /* SHORT ON PURPOSE, and the point of the case: the poll must fire on its own. */
      pollIntervalMs: 60,
      leaseStaleAfterMs: 60_000,
      adapterFactory: dials.factory,
      log: (event, detail) => { events.push({ event, detail }); },
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    await sidecar.db.update(mailboxes)
      .set({ organizeConsentedAt: new Date(), organizerRole: "organizer" })
      .where(isNull(mailboxes.organizeConsentedAt));

    dials.current.failNextConnect = new Error("ECONNREFUSED");
    await sidecar.start();
    expect(dials.connections, "the launch dial did not happen").toHaveLength(1);

    // NOTHING BELOW ASKS FOR A SYNC. If the timer was never armed, this waits out and fails.
    const deadline = Date.now() + 10_000;
    while (dials.connections.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(
      dials.connections.length,
      "the poll timer was never armed for a mailbox whose first dial failed, so nothing could "
      + "ever retry it — the only way back was quitting the app",
    ).toBeGreaterThan(1);
  }, 60_000);

  /**
   * THE MEMORY SERIES SURVIVES A CLOCK THAT MOVES BACKWARDS.
   *
   * `uptimeMs` is the x-axis of a drift measurement, and it was `Date.now()` arithmetic — so an
   * NTP step, a suspend or somebody correcting the date made the series decrease or go negative,
   * and a series whose axis runs backwards cannot answer the one question the sampler exists for.
   */
  it("REPORTS A MONOTONIC UPTIME even when the wall clock jumps backwards", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const dir = await dataDir();
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const realNow = Date.now;
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      machineName: "the machine whose clock was corrected",
      pollIntervalMs: 60 * HOUR,
      vitalsIntervalMs: 25,
      adapterFactory: dials.factory,
      log: (event, detail) => { events.push({ event, detail }); },
    });
    cleanups.push(() => sidecar.stop().catch(() => undefined));
    const uptimes = (): number[] => events
      .filter((e) => e.event === "engine_vitals")
      .map((e) => e.detail.uptimeMs as number);
    expect(uptimes()).toHaveLength(1);

    try {
      // THE CLOCK GOES BACK AN HOUR — an NTP correction, a resumed VM, a corrected date.
      Date.now = () => realNow() - 60 * 60_000;
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      Date.now = realNow;
    }

    const series = uptimes();
    expect(series.length, "the sampler stopped").toBeGreaterThan(1);
    for (const u of series) {
      expect(u, `a reading went negative (${u}ms) — the axis ran backwards`).toBeGreaterThanOrEqual(0);
    }
    for (let i = 1; i < series.length; i++) {
      expect(
        series[i]!,
        "a reading went BACKWARDS across a clock step, so the series cannot answer whether "
        + "memory is climbing",
      ).toBeGreaterThanOrEqual(series[i - 1]!);
    }
  }, 60_000);


  /**
   * ══ THE INVARIANT RESTS ON SEQUENCING, NOT ON THE REFUSAL ════════════════════════════════
   *
   * The round-three review's structural finding, written down as a test rather than as a claim:
   * in the shipped wiring the assertion CANNOT fire, because there is only ever one writer of
   * `adapter` and it is single-flighted. The refusal is a backstop for a wiring that does not
   * exist yet; what actually keeps two connections from being live under one pass is that a
   * second `syncUntilQuiet` cannot start a second re-dial while one is running.
   *
   * That property is invisible in the code — it is the `redialling` flag plus the poll chain's
   * `.finally` re-arm — so it is exactly the kind of thing that survives a refactor by accident
   * and dies by accident. Asserting it means the next person who removes the flag learns from a
   * test instead of from a mailbox with two writers.
   */
  it("A SECOND SYNC DURING A RE-DIAL DOES NOT START A SECOND ONE", async () => {
    const meta = new MemoryMetaFolder();
    let entered!: () => void;
    const dialling = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const dials = dialLog(meta, [], undefined, { park: { entered, wait: held } });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const afterLaunch = dials.connections.length;

    dials.current.killFromServer();
    // The first sync begins a re-dial and parks inside its `connect()`.
    const first = b.sidecar.syncMailbox(b.sidecar.world.mailboxId)
      .then(() => null, (e: unknown) => e);
    await dialling;
    expect(dials.connections.length, "the re-dial did not open its connection").toBe(afterLaunch + 1);

    /* THREE MORE CALLERS ARRIVE while it is parked — a poll tick and two presses of "sync now".
       None of them may open a fourth connection: the mailbox would then have two live logins and
       a pass could be gated on one while another was current. */
    const others = [1, 2, 3].map(() =>
      b.sidecar.syncMailbox(b.sidecar.world.mailboxId).then(() => null, (e: unknown) => e));
    await new Promise((r) => setTimeout(r, 60));
    expect(
      dials.connections.length,
      "a second re-dial started while one was in flight — the mailbox now holds two live "
      + "connections, and a pass gated on one can be handed the other",
    ).toBe(afterLaunch + 1);

    release();
    await first;
    await Promise.all(others);
    // And when it is over there is still exactly one connection per dial, not a backlog of them.
    expect(dials.connections.length).toBe(afterLaunch + 1);
  }, 60_000);

  /**
   * ══ ONE SOCKET DEATH IS ONE LINE — AND imapflow REPORTS EVERY DEATH TWICE ════════════════
   *
   * `_socketClose` emits `error` and then `close`, in that order, in the same tick. The
   * adapter forwards BOTH: `guardAsyncErrors`'s `error` listener is unconditional, and its
   * `close` listener is guarded only by `closing || !established` — neither of which is true
   * for a server-side death. So one dead socket calls `onConnectionError` twice, and the
   * runtime's `noteConnectionDead` runs twice at the SAME generation, past the stale-report
   * check.
   *
   * The STATE is idempotent — `connectionDeadSince` is set inside `if (… === null)` and the
   * second arrival leaves it alone — but the `log(…)` sits outside that guard, so the line
   * doubles. Measured on the Windows guest, 2026-09-07: two `mailbox_connection_unavailable`
   * lines one millisecond apart for a single cut cable.
   *
   * That makes the line count ARRIVAL PATHS and not deaths, which is the only thing anybody
   * reads it for: an operator counting outages in a log, and a release check asserting "the
   * mailbox went unreachable once". A death that happens to be reported by only one path (the
   * silent case the duration bound covers) then produces one line and an ordinary reset
   * produces two, so the same log says two different things about the same event.
   */
  it("ONE SOCKET DEATH IS ONE LINE, not one line per arrival path", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const died = dials.current;
    expect(seen(b, "mailbox_connection_unavailable"), "the launch reported a death").toHaveLength(0);

    /* THE PAIR THE SERVER ACTUALLY SENDS, in the order and the tick imapflow sends it.
       Synchronous and back-to-back on purpose: the engine answers the first arrival by QUEUEING
       a close, so a test that awaited between them would let that close land, `closedByUs` would
       be true, and the double's own `killFromServer` guard would swallow the second arrival —
       which is the lenient fixture that cannot see this defect at all. */
    died.errorFromServer(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    died.killFromServer();

    const reports = seen(b, "mailbox_connection_unavailable");
    expect(
      reports.length,
      "one socket death produced more than one `mailbox_connection_unavailable` line, so the "
      + "line counts imapflow's arrival paths rather than outages",
    ).toBe(1);
    expect(reports[0]!.detectedBy).toBe("event");
    /* THE FIRST ARRIVAL'S ERROR, which is the informative one: `error` carries the provider's own
       failure and `close` carries only `ImapConnectionClosedError`. A guard that silenced the
       FIRST arrival instead of the second would keep the count at one and lose this. */
    expect(describeError(reports[0]!.err).errorCode).toBe("ECONNRESET");

    /* ── AND THE STATE IS UNTOUCHED BY THE SILENCE ────────────────────────────────────────
     *
     * The line is what changed; the death is not. Read BEFORE the drain, because the drain is
     * the heal — a check afterwards would be asking whether the engine reconnected, which is a
     * different question and is the one below. */
    const dead = b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!;
    expect(dead.reachable, "the second arrival was suppressed along with the death").toBe(false);

    // …and the heal still runs: exactly one re-dial for one death, and it says so once.
    await b.sidecar.syncUntilQuiet().catch(() => undefined);
    expect(dials.connections, "the death was silenced INTO not being acted on").toHaveLength(2);
    expect(seen(b, "mailbox_reconnected")).toHaveLength(1);
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.reachable).toBe(true);
  }, 60_000);

  /**
   * ══ A PERSON'S "SYNC NOW" IS ANSWERED WHILE THE RE-DIAL LADDER IS WAITING ════════════════
   *
   * The ladder is right for a POLL. `redialNotBefore` widens from 15 s to a 5-minute cap so a
   * server that is down is not knocked on four times a minute, and a failed attempt does not
   * reset the clock. What it must not do is outrank a person: the network comes back, they
   * press "Sync now", and nothing happens for up to five minutes while the Settings row goes on
   * saying the server is unreachable. Measured on the Omarchy guest, 2026-09-07: five failed
   * attempts at 15/45/90/150/255 s, the sixth at +295 s, and a press in between changed
   * nothing.
   *
   * A press is not evidence that the server is back — so it does NOT reset `redialAttempts`,
   * and a failed forced attempt leaves the ladder exactly where it was. It is evidence that
   * somebody is sitting there waiting, which is worth one dial.
   *
   * THE PRESS IS DRIVEN THROUGH THE ROUTE, never through a runtime method: `POST
   * /mailboxes/:id/resync` is what `DesktopMailboxes.tsx` posts and what the browser's own
   * "Sync now" calls, and a rule proven on a function while the route's pipeline supplies
   * different operands is this repository's named `refusal-is-only-as-real-as-the-pipeline`
   * shape.
   */
  it("A PERSON'S SYNC NOW IS ANSWERED WHILE THE LADDER IS WAITING", async () => {
    const meta = new MemoryMetaFolder();
    /* MUTABLE, so the network can come back mid-test: `dialLog` reads this object on every
       re-dial, so clearing the field is the fixture's way of saying the cable is plugged in
       again. A double that could only fail for ever could not tell "the ladder holds" from
       "the ladder never lets anything through". */
    const reDial: { fails?: Error } = {
      fails: Object.assign(new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" }),
    };
    const dials = dialLog(meta, [], undefined, reDial);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const afterLaunch = dials.connections.length;

    // ── THE NETWORK GOES AWAY, AND ONE POLL ARMS THE LADDER ────────────────────────────────
    dials.current.killFromServer();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect(dials.connections.length, "the poll never re-dialled at all").toBe(afterLaunch + 1);
    expect(seen(b, "mailbox_reconnect_failed"), "the failed re-dial was not recorded").toHaveLength(1);

    // ── THE NETWORK COMES BACK. THE LADDER IS STILL WAITING, AND THAT IS CORRECT ───────────
    delete reDial.fails;
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect(
      dials.connections.length,
      "the ladder stopped holding the POLL — a server that is down would now be dialled four "
      + "times a minute",
    ).toBe(afterLaunch + 1);

    // ── AND THE PERSON PRESSES SYNC NOW ───────────────────────────────────────────────────
    const res = await b.sidecar.handle(new Request(
      `http://local/mailboxes/${encodeURIComponent(b.sidecar.world.mailboxId)}/resync`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${b.sidecar.sessionToken}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    ));
    expect(res.status, "the pane's own Sync now route was refused by this install").toBe(202);

    expect(
      await untilDials(dials, afterLaunch + 2),
      "\"Sync now\" was pressed with the network back and the install dialled nothing — the "
      + "press waits out the backoff ladder, up to five minutes, while the row says the server "
      + "is unreachable",
    ).toBe(afterLaunch + 2);
    expect(
      await until(b, "mailbox_reconnected"),
      "the forced re-dial did not report recovery within the budget a person waits",
    ).toHaveLength(1);
    const state = b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!;
    expect(state.reachable, "the row still says unreachable after a successful forced dial").toBe(true);
  }, 60_000);


  it("A REFUSED SIGN-IN OUTRANKS THE PRESS — the press buys a dial, not a password", async () => {
    /* THE ONE REFUSAL A PERSON MAY NOT OVERRIDE BY PRESSING. A server that has answered and
       rejected the sign-in will reject it again; turning a button into repeated LOGIN attempts
       is what providers throttle and what some answer by locking the account. The mailbox is
       waiting for a new password, and no number of presses is one. */
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    const refusal = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    dials.current.failNextConnect = refusal;
    await b.sidecar.start();
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.signInRefused).toBe(true);
    const afterLaunch = dials.connections.length;

    const res = await press(b, b.sidecar.world.mailboxId);
    expect(res.status, "the resync route itself refused, so this case proves nothing").toBe(202);
    await until(b, "mailbox_reconnected", 1, 300);          // give a wrong build time to dial

    expect(
      dials.connections.length,
      "a press re-attempted a sign-in the server had already rejected",
    ).toBe(afterLaunch);
  }, 60_000);

  it("A REFUSED CERTIFICATE STOPS THE LADDER, and is named rather than called an outage", async () => {
    /* The phone's TLS shim stamps a handshake the platform refused (`shims/tls.js`). A certificate
       does not heal on a five-second ladder, and "Reconnecting…" over it is a promise nothing keeps. */
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    const refusal = Object.assign(new Error("Trust anchor for certification path not found."), {
      tlsFailed: true, certificateRefused: true,
    });
    dials.current.failNextConnect = refusal;
    await b.sidecar.start();

    const state = () => b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!;
    expect(state().certificateRefused, "the refused certificate was not recognised as one").toBe(true);
    expect(state().signInRefused, "a certificate is not a password").toBe(false);
    expect(state().reachable).toBe(false);
    const afterLaunch = dials.connections.length;
    for (let i = 0; i < 5; i++) {
      await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    }
    expect(dials.connections.length, "the polls kept dialling a refused certificate").toBe(afterLaunch);
  }, 60_000);

  it("…and a PRESS asks again, and a handshake that goes through clears it", async () => {
    /* Unlike a refused sign-in, the remedy is the server's (a renewed certificate, the right host),
       so a person's press is a real question — one dial, and nothing when it is answered. */
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    dials.current.failNextConnect = Object.assign(new Error("self-signed certificate"), {
      tlsFailed: true, certificateRefused: true,
    });
    await b.sidecar.start();
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.certificateRefused).toBe(true);
    const afterLaunch = dials.connections.length;

    const res = await press(b, b.sidecar.world.mailboxId);
    expect(res.status, "the resync route itself refused, so this case proves nothing").toBe(202);
    await until(b, "mailbox_reconnected", 1, 3_000);
    expect(dials.connections.length, "the press dialled once").toBe(afterLaunch + 1);
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.certificateRefused).toBe(false);
  }, 60_000);

  it("TWO PRESSES INSIDE ONE CONNECT OPEN ONE LOGIN", async () => {
    /* `redialling` is what makes a person leaning on the button harmless. Without it the mailbox
       would hold two live logins and a pass gated on one could be handed the other — the state
       the whole single-writer design exists to prevent, reachable from a UI control. */
    const meta = new MemoryMetaFolder();
    let entered!: () => void;
    const dialling = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const dials = dialLog(meta, [], undefined, { park: { entered, wait: held } });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const afterLaunch = dials.connections.length;

    dials.current.killFromServer();
    await press(b, b.sidecar.world.mailboxId);
    await dialling;                                          // the first press is inside connect()
    expect(dials.connections.length).toBe(afterLaunch + 1);

    await press(b, b.sidecar.world.mailboxId);
    await press(b, b.sidecar.world.mailboxId);
    await new Promise((r) => setTimeout(r, 60));
    expect(
      dials.connections.length,
      "a second press opened a second login while the first was still connecting",
    ).toBe(afterLaunch + 1);

    release();
    await until(b, "mailbox_reconnected");
    expect(dials.connections.length).toBe(afterLaunch + 1);
  }, 60_000);

  it("A REFUSED RESYNC DIALS NOTHING — through the route, where the refusal THROWS", async () => {
    /* A READER, which is the refusal with product meaning: this install is not the organizer, so
       the shared handler refuses the cursor write. The runtime still EXISTS here, so a missing
       runtime is not what stops the dial — an unknown id would take the `?.` and prove nothing.
       Dialling on a refused write would make the door a way to have this machine open a socket
       without being allowed to resync.

       WHAT STOPS IT HERE IS THE THROW, not the wrapper's status test, and saying so is the
       point. Every refusal this route can make — `MailboxNotFoundError`,
       `OrganizedElsewhereError` — is THROWN and turned into a response by the error envelope
       ABOVE the handler, so `r.handler(...)` throws straight past the `res.status` check and it
       is never evaluated. Its contrary state is unreachable from this door, which is exactly the
       condition that cannot be watched fail and that a later reader takes for a guarantee. The
       case at the end of this file reaches it. */
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();
    await b.sidecar.db.update(mailboxes).set({ organizerRole: "reader" });
    const afterDeath = dials.connections.length;

    const res = await press(b, b.sidecar.world.mailboxId);
    expect(res.status, "the reader's resync was accepted").not.toBe(202);
    await until(b, "mailbox_reconnected", 1, 300);

    expect(
      dials.connections.length,
      "a refused resync still made this install dial",
    ).toBe(afterDeath);
  }, 60_000);

  it("A FORCED DIAL THAT FAILS IS INVISIBLE TO THE CALLER AND DOES NOT CRASH THE HOST", async () => {
    /* The ordinary case this exists for: the person presses while the server is still down. The
       route must still answer 202 — the resync IS queued, the cursors were nulled — and the
       rejection the drain produces must not surface as an unhandled rejection, which on this
       host is a process-level crash for a mailbox that is merely unreachable. */
    const meta = new MemoryMetaFolder();
    const stillDown = Object.assign(new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" });
    const dials = dialLog(meta, [], undefined, { fails: stillDown });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();

    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await press(b, b.sidecar.world.mailboxId);
      expect(res.status, "a press against a down server was refused").toBe(202);
      // The forced attempt runs, fails, and is recorded — the effect that proves it was entered.
      expect(await until(b, "mailbox_reconnect_failed"), "the forced dial never happened").not.toHaveLength(0);
      // Two macrotask turns: an unhandled rejection is reported at the END of a turn, so a check
      // in the same one would pass with the handler missing.
      await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(
      unhandled.map((u) => String(u)),
      "the fire-and-forget dial rejected with nobody holding it",
    ).toEqual([]);
  }, 60_000);

  it("A PRESS ON A HEALTHY MAILBOX IS AN ORDINARY RESYNC — the positive control", async () => {
    /* Every case above asserts that something does NOT happen, and a guard whose whole suite
       asserts refusals has no evidence it admits the right person. This is the ordinary press:
       the connection is live, the shared handler answers 202 — which is the effect that proves
       the wrapper passed the request through rather than swallowing it — and the engine opens no
       second login, because there is nothing dead to re-dial. */
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    expect(dials.current.live).toBe(true);
    const afterLaunch = dials.connections.length;

    const res = await press(b, b.sidecar.world.mailboxId);
    expect(res.status, "the ordinary press was refused").toBe(202);
    await until(b, "mailbox_reconnected", 1, 300);

    expect(
      dials.connections.length,
      "a press on a HEALTHY mailbox opened a second login",
    ).toBe(afterLaunch);
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.reachable).toBe(true);
  }, 60_000);

  /**
   * THE STATUS CHECK, REACHED — the contrary state the route above cannot produce.
   *
   * `withForcedRedial` is exported for this. Driven with a stub route it can be handed a handler
   * that RETURNS a refusal instead of throwing one, which is the shape the shared handler would
   * take the day somebody answers 409 rather than raising — and on that day the difference
   * between "dials only on an accepted resync" and "dials on any answer" is a door that opens a
   * socket for a request the account was refused.
   */
  it("THE WRAPPER DIALS ON AN ACCEPTED RESYNC AND ON NOTHING ELSE", async () => {
    const answered = (status: number): Route => ({
      method: "POST",
      pattern: "/mailboxes/:id/resync",
      cost: "work",
      relay: true,
      handler: async () => new Response(JSON.stringify({ status: "x" }), {
        status, headers: { "content-type": "application/json" },
      }),
    });
    /** Every `syncUntilQuiet` the wrapper asked for, with the options it passed. */
    const asked: Array<{ id: string; force: boolean | undefined }> = [];
    const runtimeFor = (id: string): { syncUntilQuiet(m?: number, o?: { force?: boolean }): Promise<number> } => ({
      syncUntilQuiet: async (_m, o) => { asked.push({ id, force: o?.force }); return 0; },
    });
    const drive = async (status: number): Promise<Response> => {
      const [wrapped] = withForcedRedial([answered(status)], runtimeFor);
      return wrapped!.handler(
        new Request("http://local/mailboxes/mbx-1/resync", { method: "POST" }),
        {} as never,
        { id: "mbx-1" },
      );
    };

    // ── ACCEPTED ────────────────────────────────────────────────────────────────────────────
    const ok = await drive(202);
    expect(ok.status, "the wrapper changed the answer").toBe(202);
    await new Promise((r) => setTimeout(r, 10));            // it is fire-and-forget
    expect(asked, "an accepted resync did not force a re-dial").toEqual([{ id: "mbx-1", force: true }]);

    // ── REFUSED, BY A HANDLER THAT RETURNS RATHER THAN THROWS ───────────────────────────────
    asked.length = 0;
    for (const status of [200, 400, 403, 404, 409, 500]) {
      const res = await drive(status);
      expect(res.status, "the wrapper rewrote a refusal").toBe(status);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(
      asked,
      "a resync the shared handler did not accept still made this install dial",
    ).toEqual([]);
  }, 60_000);

  /**
   * AND A PRESS IT CANNOT PERFORM IS REFUSED, NOT QUEUED.
   *
   * The dial was `runtimeFor(id)?.syncUntilQuiet(...)`, and the optional chain was the defect:
   * for a mailbox this install holds no runtime for, nothing was dialled and the shared
   * handler's 202 went back anyway. The pane turns a 202 into "Sync queued" and ENDS its own
   * queued mark on it, so the person is told the press was accepted while the engine never hears
   * of the mailbox — measured on a released build as `Sync queued` followed by zero engine
   * activity, with no error anywhere.
   *
   * Reaching here with no runtime is not a race with a removal: a 202 means `ownedRow` found the
   * row and `assertOrganizerRole` read `organizer`. The row is here, this install is its
   * organizer by the row's own account, and it is not running it. `disabled`-with-a-reason rows
   * are exactly that population — `loadLocalRoster` leaves them out for ever.
   *
   * The stub route is what makes the arm reachable at all, for the reason the case above gives.
   */
  it("THE WRAPPER REFUSES A 202 IT HAS NO RUNTIME FOR, AND SAYS SO ONCE", async () => {
    const accepted: Route = {
      method: "POST",
      pattern: "/mailboxes/:id/resync",
      cost: "work",
      relay: true,
      handler: async () => new Response(JSON.stringify({ status: "queued" }), {
        status: 202, headers: { "content-type": "application/json" },
      }),
    };
    const asked: string[] = [];
    const lines: Array<{ event: string; mailboxId: unknown }> = [];
    const [wrapped] = withForcedRedial(
      [accepted],
      () => undefined,
      (event, detail) => { lines.push({ event, mailboxId: detail.mailboxId }); },
    );
    const res = await wrapped!.handler(
      new Request("http://local/mailboxes/mbx-9/resync", { method: "POST" }),
      {} as never,
      { id: "mbx-9" },
    );
    expect(res.status, "a press that reaches no engine was reported as queued").toBe(503);
    const wire = await res.json() as { error?: { code?: string; message?: string } };
    expect(wire.error?.code).toBe("sync_engine_absent");
    expect(wire.error?.message, "the pane renders this sentence").toContain("not running this mailbox");
    await new Promise((r) => setTimeout(r, 10));
    expect(asked, "nothing to dial, and nothing was dialled").toEqual([]);
    expect(lines, "the refusal names the mailbox it is about")
      .toEqual([{ event: "local_mailbox_resync_unserved", mailboxId: "mbx-9" }]);
  }, 60_000);

  /**
   * THE POSITIVE CONTROL FOR THE PAIR: a mailbox WITH a runtime still gets its 202 and its dial.
   * A refusal rule whose every case is a refusal has no evidence it admits the right press, and
   * this one sits on the single control a person uses to make a stuck mailbox move.
   */
  it("…and a mailbox this install DOES run is still accepted and dialled", async () => {
    const accepted: Route = {
      method: "POST",
      pattern: "/mailboxes/:id/resync",
      cost: "work",
      relay: true,
      handler: async () => new Response(JSON.stringify({ status: "queued" }), {
        status: 202, headers: { "content-type": "application/json" },
      }),
    };
    const asked: Array<{ force: boolean | undefined }> = [];
    const lines: string[] = [];
    const [wrapped] = withForcedRedial(
      [accepted],
      () => ({ syncUntilQuiet: async (_m?: number, o?: { force?: boolean }) => { asked.push({ force: o?.force }); return 1; } }),
      (event) => { lines.push(event); },
    );
    const res = await wrapped!.handler(
      new Request("http://local/mailboxes/mbx-1/resync", { method: "POST" }),
      {} as never,
      { id: "mbx-1" },
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 10));
    expect(asked).toEqual([{ force: true }]);
    expect(lines, "an ordinary press writes no refusal line").toEqual([]);
  }, 60_000);

  /**
   * A PRESS IS WORTH ONE ATTEMPT PER BASE STEP — skipping the wait is not having no wait.
   *
   * A forced dial skips `redialNotBefore`, and a dial that fails FAST settles in well under a
   * second. So an unbounded `force` let a second press skip the wait again: a remounted pane, a
   * second window, or somebody pressing twice dialled once per press, which is the
   * four-times-a-minute knocking the ladder exists to prevent, reproduced through the one
   * control a person can hold down.
   *
   * The clock is faked for `Date` ONLY — `setTimeout` stays real, so the fire-and-forget dial
   * still settles between the presses. Freezing it also means `until()` must not be used here:
   * its deadline is `Date.now()`, which never moves, so a missing event would hang instead of
   * failing. Dial COUNT is the effect throughout, which is what the wrapper produces.
   */
  it("A SECOND PRESS INSIDE THE BASE STEP DIALS NOTHING, AND AFTER IT DIALS AGAIN", async () => {
    const meta = new MemoryMetaFolder();
    const stillDown = Object.assign(new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" });
    const reDial: { fails?: Error } = { fails: stillDown };
    const dials = dialLog(meta, [], undefined, reDial);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();
    const afterDeath = dials.connections.length;

    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      // ── PRESS ONE: dials, fails, and arms the floor ──────────────────────────────────────
      expect((await press(b, b.sidecar.world.mailboxId)).status).toBe(202);
      expect(
        await untilDialsTicked(dials, afterDeath + 1),
        "the first press did not dial",
      ).toBe(afterDeath + 1);

      // ── PRESS TWO, five seconds later: answered, and dials NOTHING ───────────────────────
      vi.setSystemTime(t0 + 5_000);
      expect(
        (await press(b, b.sidecar.world.mailboxId)).status,
        "the floor was taken out on the caller — a press must still be accepted",
      ).toBe(202);
      expect(
        await untilDialsTicked(dials, afterDeath + 2),   // a full budget's fair chance to dial
        "a second press inside the base step dialled again — repeated presses defeat the ladder",
      ).toBe(afterDeath + 1);

      // ── PRESS THREE, past the base step: dials ───────────────────────────────────────────
      vi.setSystemTime(t0 + 16_000);
      expect((await press(b, b.sidecar.world.mailboxId)).status).toBe(202);
      expect(
        await untilDialsTicked(dials, afterDeath + 2),
        "the floor never lifted — a press is rationed, not refused for good",
      ).toBe(afterDeath + 2);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  /**
   * ══ THE NETWORK'S RETURN DROPS THE WAIT (REDIAL-BACKOFF-NOT-RESET-ON-NETWORK-RETURN) ══════════
   *
   * The ladder held a dead connection for up to five minutes after the network was back, and
   * only a person's press could shorten it. The shell now relays the webview's `online` event to
   * `POST /local/mailboxes/connections/retry`, driven here through `handle` like the press.
   */
  const networkBack = async (b: Booted, token = b.sidecar.sessionToken): Promise<Response> =>
    b.sidecar.handle(new Request("http://local/local/mailboxes/connections/retry", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));

  it("A NETWORK RETURN DIALS A CONNECTION THE LADDER IS HOLDING", async () => {
    const meta = new MemoryMetaFolder();
    const reDial: { fails?: Error } = {
      fails: Object.assign(new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" }),
    };
    const dials = dialLog(meta, [], undefined, reDial);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const afterLaunch = dials.connections.length;
    dials.current.killFromServer();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect(dials.connections.length, "the poll never re-dialled at all").toBe(afterLaunch + 1);
    delete reDial.fails;
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect(dials.connections.length, "the ladder is not holding, so this case proves nothing").toBe(afterLaunch + 1);

    const res = await networkBack(b);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ redialled: 1 });
    expect(
      await untilDials(dials, afterLaunch + 2),
      "the network came back and the install waited out its ladder anyway",
    ).toBe(afterLaunch + 2);
    expect(await until(b, "mailbox_reconnected"), "the dial did not report recovery").toHaveLength(1);
    expect(seen(b, "local_network_returned")).toEqual([
      expect.objectContaining({ mailboxes: 1, count: 1 }),
    ]);
  }, 60_000);

  it("A LIVE CONNECTION IS LEFT ALONE — the positive control", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    const afterLaunch = dials.connections.length;
    const res = await networkBack(b);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ redialled: 0 });
    expect(await untilDialsTicked(dials, afterLaunch + 1, 40), "a live login was dialled again").toBe(afterLaunch);
  }, 60_000);

  it("A REFUSED SIGN-IN IS NOT RETRIED BY A NETWORK RETURN", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    dials.current.failNextConnect = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });
    await b.sidecar.start();
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.signInRefused).toBe(true);
    const afterLaunch = dials.connections.length;
    expect(await (await networkBack(b)).json()).toEqual({ redialled: 0 });
    expect(await untilDialsTicked(dials, afterLaunch + 1, 40), "a rejected sign-in was re-attempted").toBe(afterLaunch);
  }, 60_000);

  it("A SECOND RETURN INSIDE THE BASE STEP DIALS NOTHING, AND AFTER IT DIALS AGAIN", async () => {
    const meta = new MemoryMetaFolder();
    const stillDown = Object.assign(new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" });
    const dials = dialLog(meta, [], undefined, { fails: stillDown });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    const afterPoll = dials.connections.length;
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      expect(await (await networkBack(b)).json()).toEqual({ redialled: 1 });
      expect(await untilDialsTicked(dials, afterPoll + 1), "the first return did not dial").toBe(afterPoll + 1);
      vi.setSystemTime(t0 + 5_000);
      expect(await (await networkBack(b)).json(), "a flapping link defeats the ladder").toEqual({ redialled: 0 });
      expect(await untilDialsTicked(dials, afterPoll + 2)).toBe(afterPoll + 1);
      vi.setSystemTime(t0 + 16_000);
      expect(await (await networkBack(b)).json(), "the floor never lifted").toEqual({ redialled: 1 });
      expect(await untilDialsTicked(dials, afterPoll + 2)).toBe(afterPoll + 2);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  /* A SERVER THAT SAYS "NOT NOW" AT LOGIN IS NOT A REFUSED PASSWORD. imapflow stamps
     `authenticationFailed` on every failed LOGIN, a throttle included, and the engine read that
     flag alone: the re-dial stopped for good and the row said the password was rejected. */
  it("A THROTTLED SIGN-IN STAYS ON THE LADDER, and is not called a refused password", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials);
    dials.current.failNextConnect = Object.assign(new Error("Request is throttled. Suggested Backoff Time"), {
      code: "ETHROTTLE", throttleReset: 5_000, authenticationFailed: true,
    });
    await b.sidecar.start().catch(() => undefined);
    const state = b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!;
    expect(state.signInRefused, "a throttle was read as a rejected password").toBe(false);
    expect(state.reachable).toBe(false);
    const afterLaunch = dials.connections.length;
    expect(await (await networkBack(b)).json(), "the re-dial had stopped for good").toEqual({ redialled: 1 });
    expect(await untilDials(dials, afterLaunch + 1)).toBe(afterLaunch + 1);
  }, 60_000);

  it("credentialsRefused reads the server's not-now before the LOGIN flag", () => {
    const flag = { authenticationFailed: true };
    expect(credentialsRefused(Object.assign(new Error("x"), flag)), "the plain refusal").toBe(true);
    expect(credentialsRefused({ code: "OAUTH_INVALID_GRANT" })).toBe(true);
    expect(credentialsRefused({ ...flag, serverResponseCode: "AUTHENTICATIONFAILED" })).toBe(true);
    expect(credentialsRefused({ ...flag, code: "ETHROTTLE" })).toBe(false);
    expect(credentialsRefused({ ...flag, throttleReset: 92_415 })).toBe(false);
    expect(credentialsRefused({ ...flag, serverResponseCode: "LIMIT" })).toBe(false);
    expect(credentialsRefused({ ...flag, serverResponseCode: "UNAVAILABLE" })).toBe(false);
    expect(credentialsRefused({ ...flag, code: "NoConnection" })).toBe(false);
    expect(credentialsRefused({ ...flag, cause: { code: "ETHROTTLE" } }), "the wrapped shape").toBe(false);
    // A hint that is no number, and an atom the set does not hold, leave the refusal standing.
    expect(credentialsRefused({ ...flag, throttleReset: Number.NaN })).toBe(true);
    expect(credentialsRefused({ ...flag, serverResponseCode: "SECRETPASSWORD123" })).toBe(true);
  });

  it("A NETWORK RETURN WITHOUT THE LAUNCH BEARER IS REFUSED AND DIALS NOTHING", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta, [], undefined, {
      fails: Object.assign(new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" }),
    });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    const afterPoll = dials.connections.length;
    expect((await networkBack(b, "not-this-install")).status).toBe(401);
    expect(await untilDialsTicked(dials, afterPoll + 1, 40)).toBe(afterPoll);
  }, 60_000);

  /**
   * ══ A FAILED PRESS IS NOT A RUNG ON THE POLL'S LADDER ═════════════════════════════════════
   *
   * The ladder is the AUTOMATIC cadence's: `redialAttempts` is how many times the poll has found
   * the server down, and `redialNotBefore` is when the poll may look again. A press is one dial
   * for one person who is waiting — it is not evidence about the server's schedule, and the
   * function's own contract says so ("AND IT DOES NOT RESET THE LADDER").
   *
   * It said so while doing the opposite. Both ladder writes sat in the catch with no `force`
   * test, so a press that failed widened the automatic wait by a step AND restarted it from the
   * instant of the press: outage at t, poll fails (wait ≈ t+15 s), press at t+5 s fails (wait
   * ≈ t+29..41 s). The network coming back at t+8 s then healed the mailbox some twenty seconds
   * LATER than if nobody had touched it, and six presses walked the automatic wait to the
   * five-minute cap — the one control the product offers for a slow heal making the heal slower.
   *
   * WHY NINETEEN SECONDS. The poll's own wait after one failure is 15 s with its jitter, so it
   * is 18 s at the outside; the same failure with the press counted is at least 5 + 24 = 29 s.
   * Nineteen is the only number that separates them, and it separates them with no jitter luck:
   * every draw of the correct build dials there and every draw of the broken one does not.
   *
   * The clock is faked for `Date` ONLY and BEFORE the first poll, so `redialNotBefore` is
   * computed at t0 and the two waits are measured from the same origin. `setTimeout` stays real,
   * which is why the waits below are the tick-bounded helpers and not `until()`.
   */
  it("A FAILED PRESS DOES NOT PUSH THE AUTOMATIC RE-DIAL OUT", async () => {
    const meta = new MemoryMetaFolder();
    const stillDown = Object.assign(
      new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" },
    );
    const reDial: { fails?: Error } = { fails: stillDown };
    const dials = dialLog(meta, [], undefined, reDial);
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();
    const afterDeath = dials.connections.length;

    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      // ── THE POLL FINDS THE SERVER DOWN: one rung, and the wait runs from t0 ───────────────
      await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
      expect(
        dials.connections.length, "the poll never re-dialled, so nothing armed the ladder",
      ).toBe(afterDeath + 1);
      expect(
        await untilEventTicked(b, "mailbox_reconnect_failed", 1),
        "the poll's failed re-dial was not recorded",
      ).toBe(1);

      // ── A PERSON PRESSES FIVE SECONDS LATER, AND THAT PRESS FAILS TOO ────────────────────
      vi.setSystemTime(t0 + 5_000);
      expect((await press(b, b.sidecar.world.mailboxId)).status).toBe(202);
      expect(
        await untilDialsTicked(dials, afterDeath + 2), "the press did not dial",
      ).toBe(afterDeath + 2);
      /* WAITED FOR THE FAILURE, not for the dial count: the count rises when the adapter is
         built, and `redialling` stays true until the dial has settled — a poll launched in that
         window would return early for a reason that is not the ladder. */
      expect(
        await untilEventTicked(b, "mailbox_reconnect_failed", 2),
        "the forced dial never failed, so the press never reached the arm under test",
      ).toBe(2);

      // ── AND THE POLL AT NINETEEN SECONDS DIALS, BECAUSE THE LADDER WAS NOT TOUCHED ───────
      vi.setSystemTime(t0 + 19_000);
      await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
      expect(
        await untilDialsTicked(dials, afterDeath + 3),
        "a failed press pushed the automatic re-dial out — the poll at nineteen seconds dialled "
        + "nothing, so pressing \"Sync now\" while a server is down delays the app's own next "
        + "attempt instead of adding one",
      ).toBe(afterDeath + 3);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);

  /**
   * THE SAME FIX FROM THE LOG'S SIDE — `attempt` counts the poll's failures and nothing else.
   *
   * `mailbox_reconnect_failed` carries `attempt: redialAttempts`, and that field is the only
   * place anybody can read the ladder from outside: an operator counting how far the backoff has
   * walked. With the press counted, one poll and one press reported attempts 1 and 2, which says
   * the server has been found down twice when it has been found down once. Nothing else in the
   * tree reads the field, so this asserts the number a person reads, not a caller's contract.
   *
   * No fake clock here: a press with `forcedNotBefore` still at zero is admitted immediately, so
   * real time is enough to reach both failures — and keeping the clock real means this case and
   * the one above share no fixture machinery beyond the double.
   */
  it("BOTH FAILURES REPORT THE SAME ATTEMPT NUMBER — a press is not a rung", async () => {
    const meta = new MemoryMetaFolder();
    const stillDown = Object.assign(
      new Error("connect ENETUNREACH 203.0.113.9:993"), { code: "ENETUNREACH" },
    );
    const dials = dialLog(meta, [], undefined, { fails: stillDown });
    const b = await boot(await dataDir(), dials);
    await b.sidecar.start();
    dials.current.killFromServer();
    const afterDeath = dials.connections.length;

    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    expect((await press(b, b.sidecar.world.mailboxId)).status).toBe(202);
    expect(
      await until(b, "mailbox_reconnect_failed", 2),
      "the poll and the press did not both fail, so there is nothing to compare",
    ).toHaveLength(2);
    expect(dials.connections.length, "one of the two dials never happened").toBe(afterDeath + 2);

    expect(
      seen(b, "mailbox_reconnect_failed").map((d) => d.attempt),
      "the press was recorded as another failed attempt at the server, so the backoff the log "
      + "reports counts button presses",
    ).toEqual([1, 1]);
  }, 60_000);

  /**
   * THE LINK WENT HALF-OPEN — the death that emits nothing and fails no cycle. The event
   * detector needs the driver to report, the duration bound needs cycles that ran and threw, and
   * this shape gives neither: the drain parks inside its first command. These cases drive the
   * shipped detector with the window as the only thing moved — tens of milliseconds rather than
   * thirty seconds, because a suite may not wait half a minute.
   */
  it("A HALF-OPEN LINK IS STAMPED AT THE HEARTBEAT WINDOW, and the ladder runs", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: 60 });
    await b.sidecar.start();
    const wedged = dials.current;
    /* After `boot`, so it runs BEFORE the `stop()` boot pushed: a hung command holds the serial
       queue that `stop()` awaits, and a leaked one would hang the suite. */
    cleanups.push(() => wedged.endHangs());
    const afterBoot = dials.connections.length;
    wedged.goHalfOpen();

    /* Not awaited: on a half-open link this pass's drain parks inside its first command. */
    void b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);

    expect(
      (await until(b, "mailbox_connection_unavailable", 1)).map((d) => d.detectedBy),
      "the link went half-open and nothing said so — the window did not fire",
    ).toEqual(["heartbeat"]);
    expect(wedged.noops, "no NOOP was ever issued, so nothing was asked").toBeGreaterThanOrEqual(1);
    /* RE-DERIVED FROM THE INVARIANT rather than pinned at a count. The property is that a wedged
       connection is DESTROYED and never asked to log out — a LOGOUT would queue behind the hung
       command and wait out the very stall the heartbeat detected. Both the heartbeat and the
       re-dial's teardown destroy it now, so a count pins how many call sites happen to reach an
       idempotent call; `closes === 0` is the thing that must hold. */
    expect(
      wedged.forceCloses,
      "the wedged connection was not destroyed, so the stall was never ended",
    ).toBeGreaterThanOrEqual(1);
    expect(
      wedged.closes,
      "a LOGOUT was issued on a wedged connection — it queues behind the hung command",
    ).toBe(0);
    expect(
      await untilDials(dials, afterBoot + 1),
      "the ladder's first rung never ran: nothing re-dialled after the stamp",
    ).toBe(afterBoot + 1);
    expect(
      (await until(b, "mailbox_reconnected", 1)).length,
      "the replacement connection never reported the mailbox served again",
    ).toBe(1);
  }, 60_000);

  /* THE SAME HALF-OPEN LINK AFTER THE WALL CLOCK STEPPED BACK AN HOUR: the probe's cadence reads
     the monotonic clock, and the server's last activity, stamped on the wall clock before the step,
     reads as silence rather than as "heard an hour from now". */
  const halfOpenAfterStep = async (stepMs: number): Promise<unknown[]> => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const skew = { ms: 0 };
    const b = await boot(await dataDir(), dials, {
      heartbeatTimeoutMs: 60, now: () => new Date(Date.now() + skew.ms),
    });
    await b.sidecar.start();
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);   // a probe settles before the step
    const wedged = dials.current;
    cleanups.push(() => wedged.endHangs());
    expect(wedged.noops, "no probe settled before the step, so the cadence is not under test").toBeGreaterThanOrEqual(1);
    skew.ms -= stepMs;
    wedged.goHalfOpen();
    void b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    return (await until(b, "mailbox_connection_unavailable", 1)).map((d) => d.detectedBy);
  };

  it("A HALF-OPEN LINK IS STAMPED AT THE HEARTBEAT WINDOW ACROSS A WALL CLOCK STEPPED BACK AN HOUR", async () => {
    expect(await halfOpenAfterStep(HOUR), "the heartbeat waited out the clock's step").toEqual(["heartbeat"]);
  }, 60_000);

  it("CONTROL: with no step the half-open link is stamped at the window", async () => {
    expect(await halfOpenAfterStep(0)).toEqual(["heartbeat"]);
  }, 60_000);

  it("A HEARTBEAT THAT IS ANSWERED CHANGES NOTHING — the positive control", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: 60 });
    await b.sidecar.start();
    const afterBoot = dials.connections.length;

    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);

    expect(
      seen(b, "mailbox_connection_unavailable"),
      "a connection that answered its heartbeat was marked dead — the detector fires on "
      + "everything, which is the same defect as one that cannot fire",
    ).toHaveLength(0);
    /* By index, not `current`: a wrong stamp re-dials, and `current` would then be a connection
       nobody has asked — the assertion would fail with the wrong sentence. */
    expect(dials.connections[0]!.noops, "the connection was never asked").toBeGreaterThanOrEqual(1);
    expect(dials.connections.length, "a healthy connection was replaced").toBe(afterBoot);
    expect(dials.current.forceCloses, "a healthy connection was destroyed").toBe(0);
    expect(
      b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.reachable,
      "the row would read unreachable over a connection that answered",
    ).toBe(true);
  }, 60_000);

  /**
   * ── THE HEARTBEAT MAY NOT KILL A CONNECTION THAT IS STILL WORKING ────────────────────────
   *
   * imapflow writes one command at a time, so a NOOP issued while a legitimately long FETCH is
   * running sits in the queue behind it. Charging the probe's window to the connection there
   * force-closed a live link, reported the mailbox unreachable and threw the cycle away — and
   * "Sync now" pressed during a big fetch is exactly how a person reaches it.
   *
   * The command runs for ten {@link WINDOW}s and is heard from every tenth of one, so the
   * probe's deadline elapses many times over while the link is demonstrably busy.
   */
  it("A LONG HEALTHY COMMAND IS NOT INTERRUPTED BY THE HEARTBEAT — a press during a big fetch", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: WINDOW });
    await b.sidecar.start();
    const conn = dials.current;
    cleanups.push(() => conn.stopHeard());
    const afterBoot = dials.connections.length;

    /* THE BIG FETCH: ten windows long, heard from every tenth of a window throughout — a busy
       link, not a dead one, by a margin no scheduler delay closes. */
    conn.slowCycleMs = WINDOW * 10;
    conn.slowCycleHeardEveryMs = WINDOW / 10;
    const drain = b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => "threw" as const);

    /* PAST THE FIRST WINDOW before pressing, so the press's own preflight really does probe
       rather than joining the one the boot just settled. */
    await new Promise((r) => setTimeout(r, WINDOW * 1.5));
    expect((await press(b, b.sidecar.world.mailboxId)).status).toBe(202);

    expect(await drain, "the long healthy command did not finish").not.toBe("threw");
    expect(
      seen(b, "mailbox_connection_unavailable"),
      "a connection that was talking the whole time was called dead: the heartbeat charged its "
      + "window to a NOOP that was still queued behind a healthy command",
    ).toHaveLength(0);
    expect(conn.forceCloses, "the live connection was destroyed mid-fetch").toBe(0);
    expect(dials.connections.length, "a working connection was replaced").toBe(afterBoot);
    expect(
      b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.reachable,
      "the row read unreachable over a connection that was answering",
    ).toBe(true);
    /* AND THE MECHANISM, not just the outcome: the probe's window DID elapse, and the detector
       declined to blame the connection for it. Without this the case passes for a heartbeat that
       never fired at all. */
    expect(
      (await until(b, "mailbox_heartbeat_deferred", 1)).length,
      "the window never elapsed under the fetch, so this case proves nothing about the rule",
    ).toBeGreaterThanOrEqual(1);
  }, 60_000);

  /**
   * THE PROBE'S DEADLINE MEASURES SEND-TO-ANSWER, NOT QUEUE-TO-ANSWER — the same rule read as an
   * interval rather than as an outcome. A NOOP that waited many windows for the wire and was
   * answered promptly once it got there is a healthy connection, and the numbers say so.
   */
  it("A PROBE QUEUED FOR SEVERAL WINDOWS AND ANSWERED PROMPTLY IS NOT A DEATH", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: WINDOW });
    await b.sidecar.start();
    const conn = dials.current;
    const before = conn.noopTimings.length;
    conn.noopAnswerMs = WINDOW / 10;     // a tenth of the window, once it is on the wire
    conn.slowCycleMs = WINDOW * 10;      // ten windows of legitimate work ahead of it
    conn.slowCycleHeardEveryMs = WINDOW / 10;

    const drain = b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => "threw" as const);
    await new Promise((r) => setTimeout(r, WINDOW * 1.5));
    expect((await press(b, b.sidecar.world.mailboxId)).status).toBe(202);
    const drained = await drain;

    /* WAIT FOR THE QUEUED PROBE TO BE ANSWERED. `syncMailbox` resolves as soon as the drain is
       done, and the NOOP behind it is answered a few milliseconds LATER — so reading the timings
       on the line after the drain read them before the fact they are about existed. Bounded, and
       an empty list still fails the anti-vacuity assertion below. */
    const timingDeadline = Date.now() + WINDOW * 20;
    while (
      !conn.noopTimings.slice(before).some((t) => t.sentAt - t.issuedAt > WINDOW)
      && Date.now() < timingDeadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    /* THE TIMINGS FIRST, so a red here names the interval and not the outcome: a connection
       killed for its queue wait records no send at all. */
    const queued = conn.noopTimings.slice(before)
      .filter((t) => t.sentAt - t.issuedAt > WINDOW);
    expect(
      queued.length,
      "no probe waited longer than a window for the wire, so this case never reached the "
      + "distinction it exists for",
    ).toBeGreaterThanOrEqual(1);
    for (const t of queued) {
      expect(
        t.answeredAt - t.sentAt,
        "a probe answered inside the window once it was SENT — this is the interval the deadline "
        + "is for, and it is the one that was healthy",
      ).toBeLessThan(WINDOW);
      expect(
        t.answeredAt - t.issuedAt,
        "the queue wait plus the answer did NOT exceed the window, so the old queue-time clock "
        + "would not have fired and the fixture measures nothing",
      ).toBeGreaterThan(WINDOW);
    }
    expect(
      seen(b, "mailbox_connection_unavailable"),
      "the connection was called dead for time it spent waiting for the wire",
    ).toHaveLength(0);
    expect(conn.forceCloses, "a healthy connection was destroyed").toBe(0);
    expect(drained, "the long healthy command did not finish").not.toBe("threw");
  }, 60_000);

  /**
   * ── THE LINK THAT DIES AFTER THE PREFLIGHT ANSWERED ──────────────────────────────────────
   *
   * The shipped detector ran the probe as the drain's preflight and was re-armed by the drain's
   * own `.finally(schedule)`. So a link that went half-open AFTER the preflight answered hung
   * the next command, the re-arm never came, and nothing asked again: `connectionDeadSince`
   * stayed null and Settings said reachable and organized until the socket deadline fired
   * minutes later. The probe's timer is its own now, and this is the door it opens.
   */
  it("A LINK THAT GOES HALF-OPEN AFTER THE PREFLIGHT IS STAMPED ANYWAY", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: WINDOW });
    await b.sidecar.start();
    const wedged = dials.current;
    cleanups.push(() => wedged.endHangs());
    const afterBoot = dials.connections.length;

    /* PAST THE WINDOW FIRST: one probe per window, so a sync started immediately after the boot
       would skip its preflight and the door this case is about would never be opened. */
    await new Promise((r) => setTimeout(r, WINDOW * 1.3));
    /* THE PREFLIGHT ANSWERS, AND THEN THE LINK GOES QUIET: the drain command after it hangs. */
    wedged.goHalfOpenAfterNoop();
    void b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);

    expect(
      (await until(b, "mailbox_connection_unavailable", 1)).map((d) => d.detectedBy),
      "the link went half-open under a preflight that had just answered, and nothing said so: "
      + "the heartbeat was re-armed by a cycle that never finished",
    ).toEqual(["heartbeat"]);
    /* THE PREFLIGHT REALLY DID ANSWER — otherwise this is the pre-NOOP case again under a new
       name, and the door it exists for was never opened. */
    expect(
      wedged.noopSends,
      "no NOOP ever reached the wire, so the link was already wedged when the probe was issued",
    ).toBeGreaterThanOrEqual(1);
    /* RE-DERIVED, like the pre-NOOP case above: the invariant is that a wedged connection is
       DESTROYED and never asked to log out, and both the heartbeat and the re-dial's teardown
       destroy it now. `closes === 0` is the half that must hold. */
    expect(
      wedged.forceCloses,
      "the wedged connection was not destroyed, so nothing ended the hung command",
    ).toBeGreaterThanOrEqual(1);
    expect(
      wedged.closes,
      "a LOGOUT was issued on a wedged connection — it queues behind the hung command",
    ).toBe(0);
    expect(
      await untilDials(dials, afterBoot + 1),
      "nothing re-dialled after the stamp",
    ).toBe(afterBoot + 1);
  }, 60_000);

  /**
   * THE RE-ARM IS THE PROBE'S OWN, MEASURED AS A COUNT. The cycle here never resolves and the
   * link keeps being heard from, so every window produces a probe and no death — which is the
   * only shape in which "did it keep asking?" is answerable. Under the shipped code the drain's
   * preflight asked once and the re-arm waited on a cycle that never came.
   */
  it("THE HEARTBEAT KEEPS ASKING WHILE A CYCLE IS HUNG", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: WINDOW });
    await b.sidecar.start();
    const conn = dials.current;
    /* `abandon` and not `endHangs`: this case leaves the link half-open and LIVE on purpose, so
       the suite's own `stop()` would meet a polite close that never settles. See `abandon`. */
    cleanups.push(() => { conn.stopHeard(); conn.abandon(); });
    const askedAfterBoot = conn.noops;

    /* HEARD FROM, AND STUCK: the server is talking, one command of ours never comes back. */
    conn.keepHeard(WINDOW / 10);
    conn.goHalfOpen();
    void b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);

    const deadline = Date.now() + WINDOW * 40;
    while (conn.noops < askedAfterBoot + 3 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      conn.noops - askedAfterBoot,
      "the heartbeat stopped asking while the cycle was hung — the re-arm still depends on a "
      + "cycle finishing, which is the window a half-open link lives in",
    ).toBeGreaterThanOrEqual(3);
    expect(
      seen(b, "mailbox_connection_unavailable"),
      "a link the server was talking on was called dead, which is the other half of the rule",
    ).toHaveLength(0);
    conn.stopHeard();
  }, 60_000);

  it("AN ADAPTER THAT CANNOT BE ASKED IS NOT CALLED DEAD — absent is not silent", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    /* An adapter without the capability at all — absence must read as "cannot be probed", never
       as a connection that failed to answer. Only `factory` is read from this object. */
    const factory = (cfg: ImapConfig, ctx: AdapterDialContext): MailboxAdapter => {
      const built = dials.factory(cfg, ctx) as MailboxAdapter & { noop?: unknown };
      delete built.noop;
      return built;
    };
    const b = await boot(
      await dataDir(), { connections: dials.connections, factory, current: dials.current } as DialLog,
      { heartbeatTimeoutMs: 60 },
    );
    await b.sidecar.start();
    const wedged = dials.current;
    /* `abandon` and not `endHangs`: this adapter has no NOOP, so nothing ever detects the
       wedge and the link is still half-open and LIVE at teardown. See `abandon`. */
    cleanups.push(() => wedged.abandon());
    const afterBoot = dials.connections.length;
    wedged.goHalfOpen();

    void b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    /* A second pass: the line is once per attachment, not once per poll. */
    void b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);

    expect(
      await untilEventTicked(b, "mailbox_heartbeat_unavailable", 1, 40),
      "an adapter with no NOOP said nothing about it, so a log with no heartbeat lines cannot be "
      + "told from a link that never went quiet",
    ).toBe(1);
    expect(
      seen(b, "mailbox_connection_unavailable"),
      "a connection nobody could ask was stamped dead — the fail-closed rule fired on the shell "
      + "that supplies nothing instead of on a silence",
    ).toHaveLength(0);
    expect(dials.connections.length, "something re-dialled on the strength of a question that "
      + "was never asked").toBe(afterBoot);
  }, 60_000);

  /**
   * The roster route's one line. Its reading is the TRAIL, which is why the rule is
   * change-or-once-a-minute: both halves of that are what this case is about.
   */
  it("THE ROSTER ROUTE SAYS IT ANSWERED — on a change, and once a minute at rest", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    let clock = Date.UTC(2026, 8, 10, 9, 0, 0);
    const b = await boot(await dataDir(), dials, { now: () => new Date(clock) });
    await b.sidecar.start();
    const roster = async (): Promise<Response> => b.sidecar.handle(new Request(
      "http://local/local/mailboxes/connections",
      { headers: { authorization: `Bearer ${b.sidecar.sessionToken}` } },
    ));
    const lines = (): Array<Record<string, unknown>> =>
      seen(b, "local_mailbox_connections_answered");

    expect((await roster()).status).toBe(200);
    expect(
      lines(),
      "the route answered and the log says nothing, which is the state this line exists to end",
    ).toHaveLength(1);
    expect(lines()[0], "the counts are not what the route answered").toMatchObject({
      mailboxes: 1, serving: 1, refused: 0,
    });

    /* The same answer inside the minute: four lines a minute would bury the transition. */
    expect((await roster()).status).toBe(200);
    expect(lines(), "an unchanged answer inside the floor logged a second line").toHaveLength(1);

    /* A changed answer, still inside the minute: it may not wait for a floor. */
    dials.current.killFromServer();
    expect((await roster()).status).toBe(200);
    expect(lines(), "the roster changed and the log did not").toHaveLength(2);
    expect(lines()[1], "the change was logged with the old counts").toMatchObject({
      mailboxes: 1, serving: 0,
    });

    /* The floor itself. Without it the trail stops when the state settles, and a question that
       stopped arriving looks like a mailbox that is fine. */
    clock += 61_000;
    expect((await roster()).status).toBe(200);
    expect(
      lines(),
      "an unchanged answer a minute later logged nothing, so the trail this instrument is read "
      + "from stops as soon as the state settles",
    ).toHaveLength(3);
  }, 60_000);

  /**
   * The window is configuration, and a value that is not a positive number refuses the boot: a
   * `NaN` window would declare every mailbox unreachable on every poll. The table below is the
   * pure function; the case after it proves the refusal is wired at boot.
   */
  it("A WINDOW THAT IS NOT A POSITIVE NUMBER IS REFUSED, and a number is taken", () => {
    expect(resolveHeartbeatTimeoutMs({}), "the default is not the shipped 30 s")
      .toBe(DEFAULT_HEARTBEAT_TIMEOUT_MS);
    expect(resolveHeartbeatTimeoutMs({ heartbeatTimeoutMs: 5_000 })).toBe(5_000);
    const refusal = (v: unknown): string => {
      try {
        resolveHeartbeatTimeoutMs({ heartbeatTimeoutMs: v as number });
        return "accepted";
      } catch (err) {
        return err instanceof Error && err.message.includes("OHMAIL_HEARTBEAT_MS")
          ? "refused-by-name"
          : "refused-without-the-variable";
      }
    };
    /* `Number("garbage")` is what `main.ts` produces for an unreadable environment value, and it
       is the one every other arm here is a neighbour of. */
    expect(refusal(Number("garbage")), "NaN").toBe("refused-by-name");
    expect(refusal(0), "zero").toBe("refused-by-name");
    expect(refusal(-1), "negative").toBe("refused-by-name");
    expect(refusal(Number.POSITIVE_INFINITY), "infinite").toBe("refused-by-name");
    expect(refusal("30000"), "a string that looks like a number").toBe("refused-by-name");
  });

  it("THE REFUSAL IS AT THE BOOT, before a database is opened", async () => {
    const meta = new MemoryMetaFolder();
    const dials = dialLog(meta);
    /* A one-word verdict, and the handle closed if it opens: `.rejects` on a call that resolves
       to a live engine makes vitest print a PGlite over a WASM heap and kills the worker. */
    const verdict = await createSidecar({
      dataDir: await dataDir(),
      imap: {
        host: "imap.invalid", port: 993, secure: true,
        auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
      },
      address: "owner@trafficflow.test",
      pollIntervalMs: 60 * HOUR,
      adapterFactory: dials.factory,
      heartbeatTimeoutMs: Number("garbage"),
    }).then(
      (sc) => { cleanups.push(() => sc.stop().catch(() => undefined)); return "booted"; },
      (err: unknown) => (err instanceof Error && err.message.includes("OHMAIL_HEARTBEAT_MS")
        ? "refused-by-name"
        : "refused-without-the-variable"),
    );
    expect(
      verdict,
      "an unreadable heartbeat window started an engine that would report this mailbox "
      + "unreachable on every poll",
    ).toBe("refused-by-name");
    expect(dials.connections, "the refused boot dialled the mail server").toHaveLength(0);
  }, 60_000);


  /**
   * ══ THE PHONE'S BOUNDS ARE NOT THE DESKTOP'S (owner ruling, 2026-09-11) ══════════════════
   *
   * The four shipped numbers were reasoned for a process that runs for days. Device run 2 put
   * them on a phone: 2 min 27 s of failing cycles with ONE `mailbox_reconnect_failed` in them —
   * 8 cycles at a 15 s poll before the first re-dial, then a 15 s first step — while the only
   * sentence on any screen was `As of 19:42 · catching up`. A phone organizes only while ohmail
   * is open, so two minutes of silence is most of a session.
   *
   * What is pinned here is the TABLE and the SELECTOR; the case after next is the selector's
   * effect, measured over two compositions of the same engine.
   */
  it("the two profiles hold the ruled numbers, and every claim kind selects one", () => {
    expect(DESKTOP_RECONNECT.deadAfterMs).toBe(120_000);
    expect(DESKTOP_RECONNECT.deadAfterCycles).toBe(8);
    expect(PHONE_RECONNECT.deadAfterMs).toBe(45_000);
    expect(PHONE_RECONNECT.deadAfterCycles).toBe(3);
    expect(PHONE_RECONNECT.ladderMs).toEqual([5_000, 15_000, 30_000, 60_000]);

    /* THE SELECTOR, over every kind a claim can carry. `cloud` takes the desktop row and is
       named rather than defaulted: the hosted deployment does not run this composition, and an
       absent answer would be the fourth-kind-behaving-like-a-desktop shape `organizerKind`
       became a field to prevent. */
    expect(reconnectProfile("local")).toBe(DESKTOP_RECONNECT);
    expect(reconnectProfile("cloud")).toBe(DESKTOP_RECONNECT);
    expect(reconnectProfile("mobile")).toBe(PHONE_RECONNECT);
    expect(Object.keys(RECONNECT_PROFILES).sort()).toEqual(["cloud", "local", "mobile"]);

    /* AND THE PHONE IS LOWER IN EVERY FIELD. Two records that had quietly collapsed onto one
       object would satisfy every assertion above; this is what makes "the phone reads the
       desktop table" a red rather than a tie. */
    expect(PHONE_RECONNECT.deadAfterMs).toBeLessThan(DESKTOP_RECONNECT.deadAfterMs);
    expect(PHONE_RECONNECT.deadAfterCycles).toBeLessThan(DESKTOP_RECONNECT.deadAfterCycles);
    expect(PHONE_RECONNECT.ladderMs[0]).toBeLessThan(DESKTOP_RECONNECT.ladderMs[0]!);
    expect(PHONE_RECONNECT.ladderMs.at(-1)!).toBeLessThan(DESKTOP_RECONNECT.ladderMs.at(-1)!);
  });

  /**
   * THE DESKTOP'S LADDER IS THE SHIPPED DOUBLING, PROVED RATHER THAN RETYPED.
   *
   * The ladder replaced `min(BASE * 2^(n-1), MAX)` in the code, and "desktop numbers unchanged"
   * is the ruling's own clause — so the two constants stay the authority on its shape and this
   * compares them ten attempts deep, past the ladder's end where the last step repeats. A
   * hand-typed expectation would have made this assertion a copy of the thing it checks.
   */
  it("DESKTOP numbers are unchanged: the ladder IS base × 2^(n-1) capped at the maximum", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(
        redialStepMs(DESKTOP_RECONNECT, attempt),
        `attempt ${attempt} moved the desktop's shipped wait`,
      ).toBe(Math.min(REDIAL_BACKOFF_BASE_MS * 2 ** (attempt - 1), REDIAL_BACKOFF_MAX_MS));
    }
    /* THE LAST STEP REPEATS, on both profiles — the phone's ladder never runs out, which is why
       the sentence a person reads keys on the wall clock and not on an exhausted ladder. */
    for (const profile of [DESKTOP_RECONNECT, PHONE_RECONNECT] as ReconnectProfile[]) {
      const last = profile.ladderMs.at(-1)!;
      expect(redialStepMs(profile, profile.ladderMs.length)).toBe(last);
      expect(redialStepMs(profile, profile.ladderMs.length + 40)).toBe(last);
      /* A zeroth or negative attempt reads the FIRST step, never `undefined`: the ladder is
         indexed off a counter, and an off-by-one must not arm a wait of `NaN`. */
      expect(redialStepMs(profile, 0)).toBe(profile.ladderMs[0]);
      expect(redialStepMs(profile, -3)).toBe(profile.ladderMs[0]);
    }
  });

  /**
   * ══ AND THE SELECTOR DECIDES, MEASURED — a phone calls the link dead at THREE cycles ══════
   *
   * The table above is data. This is the arm that makes it behaviour: the same silent death, the
   * same fixture, two compositions, and the only difference between them is what each claims as.
   * Red if the phone reads the desktop's row — three failing cycles pass in silence, exactly as
   * the device measured — and red the other way round if the desktop picked up the phone's,
   * which is what the second half of this case is for.
   */
  it("a MOBILE composition reports the death at its own bound, and a desktop does not", async () => {
    const dials = dialLog(new MemoryMetaFolder());
    const phone = await boot(await dataDir(), dials, { organizerKind: "mobile" });
    await phone.sidecar.start();
    expect(phone.sidecar.organizerState().organizing).toBe(true);
    dials.current.dieSilently();

    /* `syncMailbox` and not `syncUntilQuiet`, for the neighbouring bound case's reason: the
       install-level method settles every runtime and reduces a rejection to 0. */
    const failOn = async (b: Booted): Promise<unknown> =>
      b.sidecar.syncMailbox(b.sidecar.world.mailboxId).then(() => null, (e: unknown) => e);

    for (let i = 1; i < PHONE_RECONNECT.deadAfterCycles; i++) {
      expect(await failOn(phone), `cycle ${i} did not fail over the dead socket`)
        .toBeInstanceOf(LeaseUnavailableError);
      expect(
        seen(phone, "mailbox_connection_unavailable"),
        `the phone called the connection dead after ${i} cycles, before its own bound`,
      ).toHaveLength(0);
    }
    expect(await failOn(phone)).toBeInstanceOf(LeaseUnavailableError);
    const reports = seen(phone, "mailbox_connection_unavailable");
    expect(reports, "the phone's bound never fired — it is reading the desktop's table")
      .toHaveLength(1);
    expect(reports[0]!.detectedBy).toBe("bound");

    /* ── THE CONTROL, AND IT IS THE WHOLE REASON THIS CASE BOOTS TWO ENGINES ───────────────
     *
     * A desktop run through the SAME number of failing cycles must still be silent. A "fix" that
     * simply lowered the shipped bound for everybody would pass the half above and fail here. */
    const deskDials = dialLog(new MemoryMetaFolder());
    const desktop = await boot(await dataDir(), deskDials);
    await desktop.sidecar.start();
    deskDials.current.dieSilently();
    for (let i = 1; i <= PHONE_RECONNECT.deadAfterCycles; i++) {
      expect(await failOn(desktop)).toBeInstanceOf(LeaseUnavailableError);
    }
    expect(
      seen(desktop, "mailbox_connection_unavailable"),
      "the desktop called its connection dead at the phone's bound — its numbers moved",
    ).toHaveLength(0);
  }, 60_000);

  /**
   * EVERY FAILED ATTEMPT SAYS WHEN THE NEXT ONE MAY HAPPEN.
   *
   * The device read one `mailbox_reconnect_failed` and then silence, and part of why that was
   * unreadable is that the line carried an attempt number and no schedule — "the next poll tries
   * again" was in its own sentence and was false. `retryInMs` is read off `redialNotBefore` AFTER
   * the arms have run, so it reports the wait that was actually armed rather than the step this
   * call site could have recomputed.
   */
  it("a failed re-dial records the attempt AND the wait it armed, on the phone's ladder", async () => {
    const dials = dialLog(
      new MemoryMetaFolder(), [], undefined,
      /* Every dial AFTER the first is refused, so the ladder is what the lines report. */
      { fails: new Error("ECONNREFUSED the route is gone") },
    );
    const b = await boot(await dataDir(), dials, { organizerKind: "mobile" });
    await b.sidecar.start();
    dials.current.dieSilently();

    const fail = async (): Promise<void> => {
      await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    };
    for (let i = 0; i < PHONE_RECONNECT.deadAfterCycles; i++) await fail();
    /* The cycle after the bound is the one that re-dials — and the dial is refused. */
    await fail();

    const lines = seen(b, "mailbox_reconnect_failed");
    expect(lines, "the failed re-dial was not recorded at all").toHaveLength(1);
    expect(lines[0]!.attempt).toBe(1);
    /* JITTERED at 0.8–1.2 of the step, so a band and not a number — and the band is the PHONE's
       first step. Asserted against the desktop's too, because "the ladder moved with the
       profile" is the claim and a 15 s first step would satisfy the band above only if the band
       were written around the wrong number. */
    const armed = lines[0]!.retryInMs as number;
    expect(armed).toBeGreaterThan(PHONE_RECONNECT.ladderMs[0]! * 0.7);
    expect(armed).toBeLessThan(PHONE_RECONNECT.ladderMs[0]! * 1.3);
    expect(armed, "the wait armed is the desktop's first step, not the phone's")
      .toBeLessThan(REDIAL_BACKOFF_BASE_MS * 0.8);
  }, 60_000);

  /**
   * ══ A LINK THAT DROPS DURING A LARGE FIRST IMPORT ═════════════════════════════════════════
   *
   * The re-dial drains inside itself, so a 5,000-letter import over a flapping link used to log
   * every progressful re-dial as `mailbox_reconnect_failed` and climb the ladder to its cap. A
   * re-dial is proven by its first served cycle; a drop after that waits the first step again.
   * Each round moves the wall clock past any wait and asks for one pass.
   */
  const flapRounds = async (
    plan: ReadonlyArray<"fail" | number | { serve: number; breach: true }>, organizerKind?: OrganizerKind,
  ): Promise<{ b: Booted; dials: DialLog }> => {
    const dials = dialLog(new MemoryMetaFolder(), [], undefined, undefined, { reDialPlan: plan });
    const b = await boot(await dataDir(), dials, organizerKind === undefined ? {} : { organizerKind });
    await b.sidecar.start();
    dials.current.killFromServer();
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    try {
      for (let round = 1; round <= plan.length; round++) {
        vi.setSystemTime(t0 + round * 400_000);
        await b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
      }
    } finally {
      vi.useRealTimers();
    }
    return { b, dials };
  };
  const inBand = (ms: unknown, stepMs: number): boolean =>
    typeof ms === "number" && ms >= stepMs * 0.8 && ms <= stepMs * 1.2;

  it("A RE-DIAL THAT SERVED MAIL AND THEN DROPPED IS A RECONNECTION, and waits the first step", async () => {
    const { b, dials } = await flapRounds([3, 3, 3]);
    expect(dials.connections).toHaveLength(4);
    expect(seen(b, "mailbox_reconnected"), "a re-dial that served mail was never called back").toHaveLength(3);
    expect(seen(b, "mailbox_reconnect_failed"), "a progressful re-dial was filed as a failed one").toHaveLength(0);
    const waits = seen(b, "mailbox_redial_after_progress").map((d) => d.retryInMs);
    expect(waits).toHaveLength(3);
    for (const w of waits) expect(inBand(w, DESKTOP_RECONNECT.ladderMs[0]!), `wait ${String(w)} climbed`).toBe(true);
  }, 60_000);

  it("CONTROL: a re-dial that drops before serving a cycle still climbs the ladder", async () => {
    const { b } = await flapRounds([0, 0, 0]);
    const failed = seen(b, "mailbox_reconnect_failed");
    expect(failed.map((d) => d.attempt)).toEqual([1, 2, 3]);
    failed.forEach((d, i) => expect(inBand(d.retryInMs, DESKTOP_RECONNECT.ladderMs[i]!)).toBe(true));
    expect(seen(b, "mailbox_reconnected")).toHaveLength(0);
    expect(seen(b, "mailbox_redial_after_progress")).toHaveLength(0);
  }, 60_000);

  it("A RE-DIAL THAT SERVED MAIL RESETS THE LADDER for the next failed dial", async () => {
    const { b } = await flapRounds(["fail", 3, "fail"]);
    expect(seen(b, "mailbox_reconnect_failed").map((d) => d.attempt), "the ladder kept climbing over served mail")
      .toEqual([1, 1]);
    expect(seen(b, "mailbox_reconnected")).toHaveLength(1);
  }, 60_000);

  it("ONLY A DROPPED LINK IS PROGRESS: a read bound after served mail keeps the failed-dial arm", async () => {
    const { b } = await flapRounds([{ serve: 3, breach: true }]);
    expect(seen(b, "mailbox_reconnected")).toHaveLength(1);
    expect(seen(b, "mailbox_reconnect_failed").map((d) => d.attempt)).toEqual([1]);
    expect(seen(b, "mailbox_redial_after_progress"), "a breach was filed as a dropped link").toHaveLength(0);
  }, 60_000);

  it("…and on the phone the progress wait is the phone's first step", async () => {
    const { b } = await flapRounds([3, 3, 3], "mobile");
    expect(seen(b, "mailbox_reconnected")).toHaveLength(3);
    expect(seen(b, "mailbox_reconnect_failed")).toHaveLength(0);
    const waits = seen(b, "mailbox_redial_after_progress").map((d) => d.retryInMs);
    expect(waits).toHaveLength(3);
    for (const w of waits) expect(inBand(w, PHONE_RECONNECT.ladderMs[0]!), `wait ${String(w)}`).toBe(true);
  }, 60_000);

  it("A RE-DIAL IS CALLED BACK, AND WATCHED, WHILE ITS IMPORT IS STILL RUNNING", async () => {
    let entered!: () => void;
    const inDrain = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    const dials = dialLog(new MemoryMetaFolder(), [], undefined, undefined, {
      reDialPlan: [{ serve: 1_000, park: { at: 2, entered: () => entered(), wait } }],
    });
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: WINDOW });
    await b.sidecar.start();
    dials.current.killFromServer();
    const pass = b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    await inDrain;
    const importing = dials.current;
    cleanups.push(() => { release(); importing.abandon(); });
    expect(await untilEventTicked(b, "mailbox_reconnected"), "the re-dial was not called back mid-import").toBe(1);
    for (let i = 0; i < 200 && importing.noops === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(importing.noops, "no heartbeat watched the new connection during its import").toBeGreaterThanOrEqual(1);
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.reachable).toBe(true);
    release();
    importing.abandon();
    await pass;
  }, 60_000);

  it("A LAUNCH WHOSE IMPORT DROPPED ARMS THE HEARTBEAT, and it watches the re-dial's import", async () => {
    let entered!: () => void;
    const inDrain = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const wait = new Promise<void>((r) => { release = r; });
    const dials = dialLog(new MemoryMetaFolder(), [], undefined, undefined, {
      dieAfterFirstCycle: { armed: true },
      reDialPlan: [{ serve: 1_000, park: { at: 2, entered: () => entered(), wait } }],
    });
    const b = await boot(await dataDir(), dials, { heartbeatTimeoutMs: WINDOW });
    expect((await b.sidecar.start()).failures).toHaveLength(1);
    // The poll is an hour away: only the heartbeat's own timer can re-dial here.
    const reDialled = await Promise.race([
      inDrain.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 40 * WINDOW)),
    ]);
    expect(reDialled, "nothing re-dialled after the failed launch").toBe(true);
    const importing = dials.current;
    cleanups.push(() => { release(); importing.abandon(); });
    for (let i = 0; i < 200 && importing.noops === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(importing.noops, "no heartbeat watched the re-dial's import").toBeGreaterThanOrEqual(1);
    importing.goHalfOpen();
    release();
    for (let i = 0; i < 200 && !seen(b, "mailbox_connection_unavailable").some((d) => d.detectedBy === "heartbeat"); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(seen(b, "mailbox_connection_unavailable").filter((d) => d.detectedBy === "heartbeat"),
      "a link that wedged under the re-dial's import was never stamped").toHaveLength(1);
    expect(importing.forceCloses).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("A CYCLE THAT ANSWERS AFTER ITS CONNECTION'S CLOSE WAS REPORTED is not served and stamps no import", async () => {
    const dials = dialLog(new MemoryMetaFolder(), [], undefined, undefined, { answerAfterClose: true });
    const b = await boot(await dataDir(), dials);
    expect((await b.sidecar.start()).failures, "the launch over a closed link read as a success").toHaveLength(1);
    const [row] = await b.sidecar.db.select({ at: mailboxes.initialImportCompletedAt }).from(mailboxes);
    expect(row?.at ?? null, "an import over a closed link was stamped complete").toBeNull();
    expect(seen(b, "first_sync_finished")).toHaveLength(0);
    expect(b.sidecar.connectionStates()[b.sidecar.world.mailboxId]!.reachable).toBe(false);
  }, 60_000);

  /**
   * ══ A STOP FINISHES ON A HALF-OPEN LINK (ruled, 2026-09-11) ═══════════════════════════════
   *
   * `detach()` awaited `tail`, and a drain parked inside a hung command holds `tail` — so on a
   * half-open link (the socket answers TCP, nothing answers IMAP: what a phone produces every
   * time it loses its route) the stop never returned. On a phone that is the foreground service
   * that will not stand down, and the `Stopping` chip device run 2 measured for ≥ 2 min 30 s.
   *
   * ASSERTED BY A BOUNDED AWAIT, never by vitest's own timeout: a hung stop has to be a named
   * failure carrying a reading, not a suite that dies after ten seconds saying nothing about
   * which promise never settled.
   */
  it("STOPS on a link whose every command hangs, and destroys the socket to do it", async () => {
    const dials = dialLog(new MemoryMetaFolder());
    /* A REAL interval, because the bound IS one drain interval — short enough that the case
       measures the rule rather than the clock. */
    const b = await boot(await dataDir(), dials, { pollIntervalMs: 300 });
    await b.sidecar.start();
    const wedged = dials.current;
    expect(wedged.live).toBe(true);

    /* THE LINK GOES HALF-OPEN AND A DRAIN PARKS IN IT. Started and deliberately not awaited:
       the parked drain is what holds `tail`, which is what `detach()` used to wait on. */
    wedged.goHalfOpen();
    const parked = b.sidecar.syncMailbox(b.sidecar.world.mailboxId).catch(() => undefined);
    /* THE PREMISE, MEASURED. Without this the stop below could win a race against a drain that
       had not started and the case would pass with no hazard present at all. */
    expect(
      await settledWithin(parked, 500),
      "the drain came back on its own — nothing is wedged, so the stop below proves nothing",
    ).toBe(false);

    const finished = await settledWithin(b.sidecar.stop(), 6_000);
    expect(
      finished,
      "the stop did not return within twenty drain intervals — a parked drain is still holding "
      + "it, which is the foreground service that will not stand down",
    ).toBe(true);

    /* AND IT ENDED THE LINK. The LOGOUT was tried first — that is the ordinary stop, and a
       teardown that skipped it on every link would be a different behaviour rather than a bound
       — and it is the wait that did not settle: the drain parks in its preflight probe, which
       runs outside the serial queue, so the queue was clear and the LOGOUT was what hung. */
    expect(wedged.closes, "the polite logout was never attempted").toBe(1);
    expect(wedged.forceCloses, "the wedged connection was not destroyed").toBe(1);
    const forced = seen(b, "mailbox_detach_forced");
    expect(forced, "a stop that gave up waiting left no line").toHaveLength(1);
    expect(forced[0]!.pollIntervalMs).toBe(300);
    expect(forced[0]!.totalMs as number).toBeGreaterThanOrEqual(300);

    /* AND THE DRAIN IS OVER TOO. Destroying the socket ends the hung command, and `stopped` is
       already true, so the cycle returns rather than issuing another. A stop that finished while
       leaving a cycle running would be the same defect one layer down. */
    expect(
      await settledWithin(parked, 5_000),
      "the stop returned and left the drain parked behind it",
    ).toBe(true);
  }, 60_000);

  /**
   * THE POSITIVE CONTROL — an ordinary stop still logs out politely and forces nothing.
   *
   * Without it the bound above would be indistinguishable from "every stop destroys the socket",
   * which would drop the in-flight cycle's committed rows on every quit.
   */
  it("an ordinary stop waits for the cycle and LOGS OUT — the bound is not a shortcut", async () => {
    const dials = dialLog(new MemoryMetaFolder());
    const b = await boot(await dataDir(), dials, { pollIntervalMs: 300 });
    await b.sidecar.start();
    const healthy = dials.current;
    await b.sidecar.syncMailbox(b.sidecar.world.mailboxId);

    expect(await settledWithin(b.sidecar.stop(), 6_000), "a healthy stop did not return").toBe(true);
    expect(healthy.closes, "a healthy connection was not logged out").toBe(1);
    expect(healthy.forceCloses, "a healthy stop destroyed the socket").toBe(0);
    expect(
      seen(b, "mailbox_detach_forced"),
      "a healthy stop reported itself as forced — the bound fires on everything",
    ).toHaveLength(0);
  }, 60_000);

});

/**
 * ══ THE BOUND ITSELF — a wait that gives up EARLY is a bound that does not hold ═══════════════
 *
 * `detach()` promises one drain interval and logs `totalMs`, and that number read 299 against its
 * own 300: `setTimeout` schedules against the event loop's cached clock, which synchronous work
 * does not refresh, so a single-shot timer can fire before `Date.now()` reaches the deadline. The
 * skew is sub-millisecond and intermittent, which is why it is asserted HERE over many short waits
 * rather than left to the one case that happened to catch it.
 */
describe("settledWithin — the deadline is wall-clock, not the loop's", () => {
  it("never gives up before the time it was given, over two hundred short waits", async () => {
    const never = new Promise<void>(() => undefined);
    let early = 0;
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const t0 = Date.now();
      /* ONE MILLISECOND, because that is where the skew lives: the shorter the wait, the larger
         the share of it a stale loop clock can eat. */
      expect(await settledWithin(never, 1)).toBe(false);
      const spent = Date.now() - t0;
      if (spent < 1) { early += 1; worst = Math.min(worst, spent - 1); }
    }
    expect(early, `${early} of 200 waits returned before their deadline (worst ${worst} ms)`).toBe(0);
  }, 30_000);
});
