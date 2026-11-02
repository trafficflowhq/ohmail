import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailboxes, tags } from "@trafficflow/db";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo, RawProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type AdapterDialContext, type Sidecar } from "../src/engine.js";
import { INGEST_LOG_FLUSH_MS } from "../src/db.js";

/**
 * THE HAND-BACK RUNS ON A LIVE CONNECTION — the engine's half of a phone that declines to organize
 * in the background. A hand-back queued behind a drain the platform froze runs at the thaw, and
 * at the base it released over the runtime's own socket, which the server had long dropped: the
 * release failed and the claim blocked the person's other install for the staleness window.
 * Here that socket answers nothing; the release must go over a fresh connection of its own.
 */

class MemoryMetaFolder {
  private nextUid = 1;
  readonly claims: RawClaimMessage[] = [];
  list(): RawClaimMessage[] { return this.claims.map((c) => ({ ...c })); }
  append(raw: string): void { this.claims.push({ ref: this.nextUid++, raw }); }
  remove(refs: readonly unknown[]): void {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
}

/** A real, empty settings folder, for a case whose settings travel. */
class MemoryProfileFolder implements ProfileIo {
  private nextUid = 1;
  readonly messages: RawProfileMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> { return this.messages.map((m) => ({ ...m })); }
  async appendProfile(raw: string): Promise<void> { this.messages.push({ ref: this.nextUid++, raw, generation: 4_100 }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.messages.length - 1; i >= 0; i--) if (gone.has(this.messages[i]!.ref)) this.messages.splice(i, 1);
  }
}

/**
 * Every dial is one adapter; the ones in `dropped` answer every `ohmail/_meta` read with a reset.
 * With `backlog.on`, `changesSince` is SOCKET-SHAPED: it answers "more to come" and settles only
 * when the case releases it (or at once under `backlog.auto`), one cycle at a time. `settings`: the
 * settings folder is a real one, so the store's settings reach it.
 */
function mailbox(opts: { settings?: true } = {}) {
  const meta = new MemoryMetaFolder();
  const settings = opts.settings === true ? new MemoryProfileFolder() : null;
  const backlog = { on: false, auto: false, calls: 0, pending: [] as (() => void)[] };
  const state = {
    dials: 0, dropped: new Set<number>(), refuseEveryDial: false, backlog,
    moves: 0, destroyed: 0, requestChannel: 0, profile: 0,
    /** The doorbell the engine registered on the latest dial — ringing it is an INBOX arrival. */
    ring: null as (() => void) | null,
    /** What the engine handed each dial: the runtime's own reports its socket's death through it. */
    dialled: new Map<number, AdapterDialContext>(),
  };
  const empty: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
  const factory = (_cfg: ImapConfig, ctx?: AdapterDialContext): MailboxAdapter & { leaseIo(): LeaseIo } => {
    const id = ++state.dials;
    if (ctx !== undefined) state.dialled.set(id, ctx);
    const live = (): void => {
      if (state.dropped.has(id)) throw Object.assign(new Error("socket reset by peer"), { code: "ECONNRESET" });
    };
    const io: LeaseIo = {
      async ensureMetaFolder() { live(); },
      async listClaims() { live(); return meta.list(); },
      async findOwnRecords() { live(); return meta.list(); },
      async appendClaim(raw: string) { live(); meta.append(raw); },
      async removeClaims(refs: readonly unknown[]) { live(); meta.remove(refs); },
      uidValidity: () => 4_100,
    } as LeaseIo;
    return {
      leaseIo: () => io,
      async connect(): Promise<void> {
        if (state.refuseEveryDial && id > 1) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        if (!backlog.on) return { ...empty };
        backlog.calls += 1;
        if (!backlog.auto) await new Promise<void>((r) => { backlog.pending.push(r); });
        return { ...empty, hasBacklog: true };
      },
      async move(locator: NativeLocator): Promise<NativeLocator> { state.moves += 1; return locator; },
      forceClose(): void { state.destroyed += 1; },
      /* The request channel's door, counted and refused as a retired adapter refuses it. */
      requestOrganizerIo(): never { state.requestChannel += 1; throw new Error("retired"); },
      /* And the profile publish's, the same way: unseeded, every organizer pass asks for it. */
      profileIo(): ProfileIo {
        if (settings !== null) return settings;
        state.profile += 1;
        throw new Error("retired");
      },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(onSignal: () => void): Promise<() => Promise<void>> { state.ring = onSignal; return async () => {}; },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("this mailbox cannot send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
    } as MailboxAdapter & { leaseIo(): LeaseIo };
  };
  /** The runtime's socket dies and says so, and no later dial reaches the server. */
  const cut = (): void => {
    state.refuseEveryDial = true;
    state.dropped.add(state.dials);
    state.dialled.get(state.dials)?.onConnectionError(Object.assign(new Error("socket reset by peer"), { code: "ECONNRESET" }));
  };
  return { meta, settings, state, factory, cut };
}

describe("a hand-back that runs on a dropped socket releases over a fresh one", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** `decided`: a tag in the store before the first pass, so that pass writes a settings copy. */
  async function boot(box: ReturnType<typeof mailbox>, opts: { decided?: string } = {}): Promise<Sidecar> {
    const dataDir = await freshDataDir("ohmail-hand-back-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "phone-shaped host",
      pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      adapterFactory: box.factory, log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop(); rmSync(dataDir, { recursive: true, force: true }); });
    await grantOrganizeConsent(sidecar);
    if (opts.decided !== undefined) await decide(sidecar, opts.decided);
    await sidecar.start();
    return sidecar;
  }
  /** A tag made on this install: a decision its settings carry. */
  async function decide(sidecar: Sidecar, name: string): Promise<void> {
    const [row] = await sidecar.db.select({ accountId: mailboxes.accountId }).from(mailboxes).limit(1);
    const at = new Date();
    await sidecar.db.insert(tags).values({ accountId: row!.accountId, name, createdAt: at, updatedAt: at });
  }

  it("the runtime's socket was dropped at the freeze: the claim goes over a dial of its own", async () => {
    const box = mailbox();
    const sidecar = await boot(box);
    expect(box.meta.claims.length, "the premise: this install holds the claim").toBe(1);
    box.state.dropped.add(box.state.dials);          // the thaw: the server let go of this socket
    const before = box.state.dials;

    const answer = await sidecar.handBack();
    expect(answer[0]!.released, "the release answered a count, so the app may say it went back").toBe(1);
    expect(box.meta.claims.length, "the claim is gone from ohmail/_meta").toBe(0);
    expect(box.state.dials, "the release went over a connection of its own").toBe(before + 1);
  }, 30_000);

  it("CONTROL — a live socket releases on the runtime's own connection and dials nothing", async () => {
    const box = mailbox();
    const sidecar = await boot(box);
    const before = box.state.dials;
    const answer = await sidecar.handBack();
    expect(answer[0]!.released).toBe(1);
    expect(box.meta.claims.length).toBe(0);
    expect(box.state.dials).toBe(before);
  }, 30_000);

  it("CONTROL — no connection at all is 'could not look', never a hand-back", async () => {
    const box = mailbox();
    const sidecar = await boot(box);
    box.state.dropped.add(box.state.dials);
    box.state.refuseEveryDial = true;
    const answer = await sidecar.handBack();
    expect(answer[0]!.released).toBeNull();
    expect(box.meta.claims.length, "the claim still stands, and the app says so").toBe(1);
  }, 30_000);

  /* NO CONNECTION RAN THE SETTINGS WRITE THIS HAND-BACK OWED: the runtime's socket died and the fresh dial was refused,
     so a decision since the last write is on this install only. The hand-back says not saved, as a flush that failed
     does, and the store's read says so until a write lands; one that owed nothing (already handed back) says nothing.
     On the way out (`leaving`) the read is the store against the last copy, never the press's shortcut. */
  it("the socket died and no dial reaches the server: the hand-back that owed the settings write says not saved", async () => {
    const box = mailbox({ settings: true });
    const sidecar = await boot(box, { decided: "mine" });
    // An ordinary drain, rung as an arrival rings it, publishes the settings: the launch's import pass does not.
    for (let i = 0; i < 100 && box.settings!.messages.length === 0; i++) { box.state.ring?.(); await settle(50); }
    const [id, organizing] = Object.entries(sidecar.organizerStates())[0]!;
    expect({ organizing: organizing.organizing, claimed: organizing.claimed, copies: box.settings!.messages.length }, "the premise")
      .toEqual({ organizing: true, claimed: true, copies: 1 });
    await decide(sidecar, "offline");
    const read = async () => ({ pressed: await sidecar.settingsLeftOnlyHere(id), leaving: await sidecar.settingsLeftOnlyHere(id, { leaving: true }) });
    const decided = await read();
    box.cut();
    const answer = await sidecar.handBack();
    const handedBack = { released: answer[0]!.released, left: sidecar.organizerStates()[id]!.settingsLeft, read: await read() };
    await sidecar.handBack();
    expect({ decided, handedBack, again: sidecar.organizerStates()[id]!.settingsLeft, copies: box.settings!.messages.length }).toEqual({
      decided: { pressed: "none", leaving: null },
      handedBack: { released: null, left: "not_saved", read: { pressed: null, leaving: null } },
      again: undefined, copies: 1,
    });
  }, 30_000);
});

/** The real clock, taken before any case fakes one: the bounds below must not stop with the timers. */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const settle = (ms: number): Promise<"timeout"> =>
  new Promise((r) => { realSetTimeout(() => r("timeout"), ms); });
async function until(pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("the fixture never reached the state the case needs");
    await settle(5);
  }
}

describe("a hand-back asked mid-drain goes out at the next cycle edge", () => {
  /**
   * with the notification refused, Back queued the hand-back behind the launch drain,
   * whose yield is a `setTimeout` the paused host never fires. The latch is set in the caller's
   * tick and read at the cycle edge AHEAD of that yield, so the release is next in the queue and
   * reaches the server on the socket the cycle was already using.
   */
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    vi.useRealTimers();
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(box: ReturnType<typeof mailbox>, pollIntervalMs = 60 * 60 * 1000) {
    const lines: { event: string; detail?: Record<string, unknown> }[] = [];
    const dataDir = await freshDataDir("ohmail-hand-back-edge-");
    const sidecar = await createSidecar({
      dataDir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "phone-shaped host",
      pollIntervalMs, leaseStaleAfterMs: 60_000,
      adapterFactory: box.factory, log: (event, detail) => { lines.push({ event, detail }); },
    });
    cleanups.push(async () => {
      for (const r of box.state.backlog.pending.splice(0)) r();
      box.state.backlog.auto = true;
      await sidecar.stop();
      rmSync(dataDir, { recursive: true, force: true });
    });
    await grantOrganizeConsent(sidecar);
    await sidecar.start();
    return { sidecar, lines };
  }

  /** Run a forced drain and hold it inside its third cycle. The drain rides in an object: an
      async function returning the promise itself would wait for the whole drain. */
  async function midDrain(box: ReturnType<typeof mailbox>, sidecar: Sidecar) {
    box.state.backlog.on = true;
    const drain = sidecar.resume();
    for (let done = 0; done < 2; done += 1) {
      await until(() => box.state.backlog.pending.length === 1);
      box.state.backlog.pending.shift()!();
    }
    await until(() => box.state.backlog.pending.length === 1);
    return { drain };
  }

  it("(a) the release lands after exactly the cycle in flight, on the same socket", async () => {
    const box = mailbox();
    const { sidecar, lines } = await boot(box);
    expect(box.meta.claims.length, "the premise: this install holds the claim").toBe(1);
    const { drain } = await midDrain(box, sidecar);
    const dials = box.state.dials;
    const callsAtAsk = box.state.backlog.calls;
    const movesAtAsk = box.state.moves;
    const channelAtAsk = box.state.requestChannel;
    const profileAtAsk = box.state.profile;

    const handedBack = sidecar.handBack();
    box.state.backlog.auto = true;                   // any cycle after the edge answers at once
    box.state.backlog.pending.shift()!();
    const answer = await Promise.race([handedBack, settle(20_000)]);
    expect(answer, "the hand-back never answered").not.toBe("timeout");
    await drain;

    const after = box.state.backlog.calls - callsAtAsk;
    expect(after, `the hand-back waited behind ${after} more cycle(s)`).toBe(0);
    expect(answer === "timeout" ? "timeout" : answer[0]!.released).toBe(1);
    expect(box.meta.claims.length, "the claim is gone from ohmail/_meta").toBe(0);
    const drainLine = lines.filter((l) => l.event === "sync_drain").at(-1);
    expect(drainLine?.detail?.cycles, "the drain ran one cycle past the ask").toBe(3);
    expect(lines.some((l) => l.event === "organizer_hand_back_at_cycle_edge")).toBe(true);
    expect(box.state.destroyed, "a connection was torn down to make room").toBe(0);
    expect(box.state.dials, "the release dialled instead of using the live socket").toBe(dials);
    expect(box.state.moves - movesAtAsk).toBe(0);
    expect(box.state.requestChannel - channelAtAsk, "the request channel ran after the latch").toBe(0);
    /* One profile ask after the latch, and it is the release's own: the settings flushed on the
       release connection while the claim is still held (`flushBeforeLeaving`). The drain's
       post-cycle publish stays skipped under the latch. */
    expect(box.state.profile - profileAtAsk, "a profile publish other than the release's flush ran after the latch").toBe(1);
  }, 60_000);

  it("(b) no timer stands between the edge and the release — it lands with the clock stopped", async () => {
    /* React Native drops timer callbacks at host pause when no headless task is running, which is
       where this is called. Faked here and never advanced: a `setTimeout` anywhere between the
       cycle edge and the release keeps the release from ever landing. `setImmediate` stays real,
       as it is on the device. */
    const box = mailbox();
    const { sidecar } = await boot(box);
    const { drain } = await midDrain(box, sidecar);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const handedBack = sidecar.handBack();
    box.state.backlog.auto = true;
    box.state.backlog.pending.shift()!();
    const answer = await Promise.race([handedBack, settle(10_000)]);
    expect(answer, "the release waited on a timer the paused host never fires").not.toBe("timeout");
    expect(box.meta.claims.length).toBe(0);
    vi.useRealTimers();
    await Promise.race([drain, settle(5_000)]);
  }, 60_000);

  it("(c) the drain's own re-arm is refused: no poll timer stands after a latched hand-back", async () => {
    /* A poll-started drain re-arms the poll in its `.finally`. After the latch that is a cycle
       queued behind a phone that has just left, so the timer itself is what is watched: the loop's
       own latch keeps a re-armed poll's drain cycle-less, and a `sync_drain` count cannot see it.
       The drain is the doorbell's, which runs on the poll timer's own callback. */
    const box = mailbox();
    const { sidecar } = await boot(box);
    box.state.backlog.on = true;
    expect(box.state.ring, "the premise: the engine registered its doorbell").not.toBeNull();
    box.state.ring!();                                             // an arrival: a timer-run drain
    await until(() => box.state.backlog.pending.length === 1);   // that drain, mid-cycle
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const handedBack = sidecar.handBack();
    box.state.backlog.auto = true;
    box.state.backlog.pending.shift()!();
    expect(await Promise.race([handedBack, settle(10_000)])).not.toBe("timeout");
    await settle(50);
    /* The store's own log flush is the one timer that may stand: a one-second deadline the last
       cycle's relaxed commit armed (`db.ts`). It is run out first; a poll timer, an interval of
       fifteen seconds or more, is not, so it is still counted below. */
    await vi.advanceTimersByTimeAsync(INGEST_LOG_FLUSH_MS);
    await settle(50);
    expect(vi.getTimerCount(), "a poll timer was armed after the hand-back").toBe(0);
    vi.useRealTimers();
    const calls = box.state.backlog.calls;
    await settle(200);
    expect(box.state.backlog.calls, "a cycle ran after the hand-back").toBe(calls);
  }, 60_000);

  it("(d) the latch alone — `leave()` ends the drain at the edge and keeps the claim; a resume lifts it", async () => {
    /* A phone's Back queued behind a resume: the latch comes first, the decision later. Nothing is
       released until the caller says so, and a resume takes the drain up again on the same claim. */
    const box = mailbox();
    const { sidecar, lines } = await boot(box);
    const { drain } = await midDrain(box, sidecar);
    const callsAtAsk = box.state.backlog.calls;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    sidecar.leave();
    box.state.backlog.auto = true;
    box.state.backlog.pending.shift()!();
    const ended = await Promise.race([drain, settle(10_000)]);
    expect(ended, "the drain did not end at the edge with the clock stopped").not.toBe("timeout");
    vi.useRealTimers();
    expect(box.state.backlog.calls - callsAtAsk, "a cycle ran past the edge").toBe(0);
    expect(lines.some((l) => l.event === "organizer_hand_back_at_cycle_edge")).toBe(true);
    expect(box.meta.claims.length, "the latch alone released the claim").toBe(1);
    const served = await sidecar.resume();
    expect(served[0]!.served, "the resume did not take the drain up again").toBeGreaterThan(0);
    expect(box.meta.claims.length).toBe(1);
  }, 60_000);

  it("CONTROL — a resume after it clears the latch and the poll runs again", async () => {
    const box = mailbox();
    const { sidecar, lines } = await boot(box, 50);
    await sidecar.handBack();
    expect(box.meta.claims.length).toBe(0);
    const served = await sidecar.resume();
    expect(served, "the resume answered no count for the mailbox").toHaveLength(1);
    expect(served[0]!.served, "the resume's forced cycle was not served").toBeGreaterThan(0);
    expect(box.meta.claims.length, "the resume did not take the mailbox back").toBe(1);
    /* THE COUNTERS ARM (a) READS AS ZERO DO COUNT: an unlatched pass asks both doors. */
    expect(box.state.requestChannel, "the request channel never reached the fixture").toBeGreaterThan(0);
    expect(box.state.profile, "the profile publish never reached the fixture").toBeGreaterThan(0);
    const drains = lines.filter((l) => l.event === "sync_drain").length;
    await until(() => lines.filter((l) => l.event === "sync_drain").length > drains, 5_000);
  }, 60_000);
});
