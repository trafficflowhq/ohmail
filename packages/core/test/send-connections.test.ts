import { describe, expect, it } from "vitest";
import { IMAP_READ_DEADLINE_MS } from "../src/adapters/imap-bounds.js";
import type { OutboundMessage } from "../src/send.js";
import { KEPT_PROVE_MS, SendConnections, type KeepTimers, type WarmSendAdapter } from "../src/send-connections.js";

/**
 * THE SEND DOOR REUSES A LIVE CONNECTION AND DIALS ONLY WHEN NONE EXISTS — the keeper, over
 * doubles that fail the way production fails: `isLive()` reads imapflow's `usable`, which is
 * cleared when the socket dies, so a dead double flips that flag and nothing else.
 *
 * THE MUTATION THAT MAKES THIS RED: in `SendConnections.open`, the reuse branch
 * `if (entry.real.isLive()) return this.lease(entry);` — drop it (always dial) and (1), (4) and
 * (5) go red on the dial count; make it `if (true)` and (3) goes red because a dead connection
 * is handed out. Watched fail and restored. (14) to (16) are red without the `prove` check.
 */

const MSG: OutboundMessage = { from: "a@x.test", to: "b@x.test", subject: "s", text: "t" };

function fakeTimers(): KeepTimers & { fire(): number; armed: number[] } {
  const pending = new Map<number, () => void>();
  const armed: number[] = [];
  let n = 0;
  return {
    armed,
    set(fn, ms) { n += 1; pending.set(n, fn); armed.push(ms); return n; },
    clear(t) { pending.delete(t as number); },
    /** Fire every armed timer once; answers how many fired. */
    fire() { const fns = [...pending.values()]; pending.clear(); for (const f of fns) f(); return fns.length; },
  };
}

/** A connected double: live until `die()`, counting sends and closes; `silent` NOOPs never answer. */
function connection(name: string) {
  const state = { name, live: true, sends: 0, closes: 0, forced: 0, noops: 0, silent: false };
  const real: WarmSendAdapter = {
    noop() { state.noops += 1; return state.silent ? new Promise<void>(() => undefined) : Promise.resolve(); },
    async send() { state.sends += 1; return { providerMessageId: `<${name}-${state.sends}@x>` }; },
    async messageInSent() { return false; },
    async close() { state.closes += 1; state.live = false; },
    forceClose() { state.forced += 1; state.live = false; },
    isLive: () => state.live,
  };
  return { real, state, die() { state.live = false; } };
}

function dialler() {
  const made: ReturnType<typeof connection>[] = [];
  let gate: (() => void) | null = null;
  return {
    made,
    dials: () => made.length,
    /** The next dial parks until `release()` — for the coalescing arm. */
    hold() { return new Promise<void>((r) => { gate = r; }); },
    release() { gate?.(); gate = null; },
    dial: async (): Promise<WarmSendAdapter> => {
      const c = connection(`c${made.length + 1}`);
      made.push(c);
      if (gate) await new Promise<void>((r) => { const g = gate; gate = () => { g?.(); r(); }; });
      return c.real;
    },
  };
}

describe("SendConnections — one connection across consecutive presses", () => {
  it("(1) three presses, one dial: the released connection serves the next press", async () => {
    const timers = fakeTimers();
    const keep = new SendConnections({ timers });
    const d = dialler();
    for (let press = 1; press <= 3; press++) {
      const a = await keep.open("mb-1", d.dial);
      await a.send(MSG);
      await a.close();
    }
    expect(d.dials()).toBe(1);
    expect(d.made[0]!.state.sends).toBe(3);
    // Kept, not closed: the press's `close()` is a release.
    expect(d.made[0]!.state.closes).toBe(0);
    expect(keep.size()).toBe(1);
  });

  it("(2) the idle clock is the adapter's read deadline, and firing it closes the connection", async () => {
    const timers = fakeTimers();
    const keep = new SendConnections({ timers });
    const d = dialler();
    const a = await keep.open("mb-1", d.dial);
    await a.close();
    expect(timers.armed).toEqual([IMAP_READ_DEADLINE_MS]);   // no new number
    expect(timers.fire()).toBe(1);
    expect(d.made[0]!.state.closes).toBe(1);
    expect(keep.size()).toBe(0);
    // The next press dials again — nothing is held past the ceiling.
    await keep.open("mb-1", d.dial);
    expect(d.dials()).toBe(2);
  });

  it("(3) a kept connection that died is dropped and the press re-dials rather than failing", async () => {
    const timers = fakeTimers();
    const keep = new SendConnections({ timers });
    const d = dialler();
    const a = await keep.open("mb-1", d.dial);
    await a.close();
    d.made[0]!.die();                       // the server closed the idle socket: `usable` false
    const b = await keep.open("mb-1", d.dial);
    await b.send(MSG);
    expect(d.dials()).toBe(2);
    expect(d.made[0]!.state.sends).toBe(0);    // never offered a command
    expect(d.made[0]!.state.forced).toBe(1);   // torn down, not politely LOGOUTed
    expect(d.made[1]!.state.sends).toBe(1);
  });

  it("(4) two presses during one dial share it — one LOGIN, both leased, the clock waits for both", async () => {
    const timers = fakeTimers();
    const keep = new SendConnections({ timers });
    const d = dialler();
    const parked = d.hold();
    const p1 = keep.open("mb-1", d.dial);
    const p2 = keep.open("mb-1", d.dial);
    d.release();
    await parked;
    const [a, b] = await Promise.all([p1, p2]);
    expect(d.dials()).toBe(1);
    await a.close();
    expect(timers.armed).toEqual([]);          // one lease still open: no idle clock yet
    await b.close();
    expect(timers.armed).toEqual([IMAP_READ_DEADLINE_MS]);
  });

  it("(5) a second close on one lease releases once — the other press keeps its connection", async () => {
    const timers = fakeTimers();
    const keep = new SendConnections({ timers });
    const d = dialler();
    const a = await keep.open("mb-1", d.dial);
    const b = await keep.open("mb-1", d.dial);
    await a.close();
    await a.close();                            // the send path's `finally` and a follower
    expect(timers.armed).toEqual([]);           // b still holds it
    await b.close();
    expect(timers.armed).toHaveLength(1);
  });

  it("(6) forceClose from a lease destroys the connection and forgets it", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const d = dialler();
    const a = await keep.open("mb-1", d.dial);
    a.forceClose!();
    expect(d.made[0]!.state.forced).toBe(1);
    expect(keep.size()).toBe(0);
    await keep.open("mb-1", d.dial);
    expect(d.dials()).toBe(2);
  });

  it("(7) a double without isLive is handed back uncached — the existing fakes dial every time", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    let dials = 0;
    const dial = async (): Promise<WarmSendAdapter> => {
      dials += 1;
      return { async send() { return { providerMessageId: "<x@x>" }; }, async messageInSent() { return false; }, async close() {} };
    };
    await (await keep.open("mb-1", dial)).close();
    await (await keep.open("mb-1", dial)).close();
    expect(dials).toBe(2);
    expect(keep.size()).toBe(0);
  });

  it("(8) a refused dial propagates to every press waiting on it and keeps nothing", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const dial = async (): Promise<WarmSendAdapter> => { throw new Error("LOGIN refused"); };
    await expect(keep.open("mb-1", dial)).rejects.toThrow(/LOGIN refused/);
    expect(keep.size()).toBe(0);
  });

  it("(9) connections are kept per mailbox, and closeAll closes every one", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const d = dialler();
    await (await keep.open("mb-1", d.dial)).close();
    await (await keep.open("mb-2", d.dial)).close();
    expect(d.dials()).toBe(2);
    expect(keep.size()).toBe(2);
    await keep.closeAll();
    expect(keep.size()).toBe(0);
    expect(d.made.map((c) => c.state.closes)).toEqual([1, 1]);
  });

  it("(10) closeAll within a bound destroys the connection whose LOGOUT never answers, and only it", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const d = dialler();
    await (await keep.open("mb-1", d.dial)).close();
    await (await keep.open("mb-2", d.dial)).close();
    // mb-1's server never answers the LOGOUT.
    d.made[0]!.real.close = () => new Promise<void>(() => undefined);
    const began = performance.now();
    await keep.closeAll({ withinMs: 200 });
    const took = performance.now() - began;
    expect(took).toBeGreaterThanOrEqual(190);
    expect(took).toBeLessThan(1_000);
    expect(d.made.map((c) => c.state.forced)).toEqual([1, 0]);
    expect(d.made[1]!.state.closes).toBe(1);
    expect(keep.size()).toBe(0);
  });

  it("(11) closeAll within a bound leaves a leased connection to its send, and closes it on release", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const d = dialler();
    const leased = await keep.open("mb-1", d.dial);
    let ended = false;
    const closing = keep.closeAll({ withinMs: 2_000 }).then(() => { ended = true; });
    await new Promise((r) => { setTimeout(r, 50); });
    expect(d.made[0]!.state.closes, "the send's connection was logged out under it").toBe(0);
    expect(ended, "closeAll returned while a send held its connection").toBe(false);
    expect(keep.size(), "a new press could still lease the connection").toBe(0);
    await leased.send(MSG);
    await leased.close();
    await closing;
    expect(d.made[0]!.state).toMatchObject({ sends: 1, closes: 1, forced: 0 });
  });

  it("(12) a lease never released is destroyed at the bound", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const d = dialler();
    await keep.open("mb-1", d.dial);
    const began = performance.now();
    await keep.closeAll({ withinMs: 200 });
    expect(performance.now() - began).toBeGreaterThanOrEqual(190);
    expect(d.made[0]!.state).toMatchObject({ closes: 0, forced: 1 });
  });

  it("(13) the lease forwards send's options and the copy filing, and reads dead once released", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const seen: { opts?: unknown; filed?: [number, string, unknown] } = {};
    const real: WarmSendAdapter = {
      async send(_msg, opts) { seen.opts = opts; return { providerMessageId: "<p@x>", unfiledCopy: Buffer.from("raw") }; },
      async fileSentCopy(raw, id, o) { seen.filed = [raw.length, id, o]; return null; },
      async messageInSent() { return false; },
      async close() { /* kept */ },
      isLive: () => true,
    };
    const lease = await keep.open("mb-1", async () => real);
    const beforeRelease = async (): Promise<void> => undefined;
    const res = await lease.send(MSG, { copy: "caller", beforeRelease });
    expect(seen.opts).toEqual({ copy: "caller", beforeRelease });
    expect(res.unfiledCopy?.toString()).toBe("raw");
    expect(await lease.fileSentCopy!(Buffer.from("raw"), "<p@x>", { look: true })).toBeNull();
    expect(seen.filed).toEqual([3, "<p@x>", { look: true }]);
    expect(lease.isLive?.()).toBe(true);
    await lease.close();
    expect(lease.isLive?.(), "a released lease is not a connection to probe on").toBe(false);
  });

  it("(14) with the check on, a kept connection whose NOOP never answers is destroyed at the bound and the press dials", async () => {
    const timers = fakeTimers();
    const keep = new SendConnections({ timers });
    const d = dialler();
    await (await keep.open("mb-1", d.dial, { prove: true })).close();
    d.made[0]!.state.silent = true;             // the server froze; imapflow's `usable` still reads true
    const opening = keep.open("mb-1", d.dial, { prove: true });
    await new Promise((r) => { setImmediate(r); });
    expect(timers.armed.at(-1)).toBe(KEPT_PROVE_MS);
    timers.fire();
    const b = await opening;
    await b.send(MSG);
    expect(d.dials()).toBe(2);
    expect(d.made[0]!.state).toMatchObject({ noops: 1, sends: 0, forced: 1 });
    expect(d.made[1]!.state.sends).toBe(1);
  });

  it("(15) with the check on, a connection that answers costs one NOOP and no second dial", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const d = dialler();
    await (await keep.open("mb-1", d.dial, { prove: true })).close();
    expect(d.made[0]!.state.noops, "a fresh dial is not checked").toBe(0);
    const b = await keep.open("mb-1", d.dial, { prove: true });
    await b.send(MSG);
    expect(d.dials()).toBe(1);
    expect(d.made[0]!.state).toMatchObject({ noops: 1, sends: 1, forced: 0 });
  });

  it("(16) a silent connection another press holds is forgotten but left to it; its release closes it", async () => {
    const timers = fakeTimers();
    const keep = new SendConnections({ timers });
    const d = dialler();
    const holder = await keep.open("mb-1", d.dial, { prove: true });
    d.made[0]!.state.silent = true;
    const opening = keep.open("mb-1", d.dial, { prove: true });
    await new Promise((r) => { setImmediate(r); });
    timers.fire();
    const b = await opening;
    expect(d.dials()).toBe(2);
    expect(d.made[0]!.state.forced, "destroyed under the press holding it").toBe(0);
    await holder.close();
    expect(d.made[0]!.state.closes).toBe(1);
    await b.close();
    expect(d.made[1]!.state.closes, "the new connection is the one kept").toBe(0);
    expect(keep.size()).toBe(1);
  });

  it("(17) without the check, a kept connection is reused with no NOOP (every other door)", async () => {
    const keep = new SendConnections({ timers: fakeTimers() });
    const d = dialler();
    await (await keep.open("mb-1", d.dial)).close();
    d.made[0]!.state.silent = true;
    await (await keep.open("mb-1", d.dial)).close();
    expect(d.dials()).toBe(1);
    expect(d.made[0]!.state.noops).toBe(0);
  });
});
