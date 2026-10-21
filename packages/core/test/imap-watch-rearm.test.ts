import { describe, it, expect } from "vitest";
import { ImapAdapter } from "../src/adapters/imap.js";

/**
 * `watch()` / `rearmWatch()` — the wake channel's two halves, against a recording client.
 *
 * The production defect these guard (measured: minutes from arrival to mirror): imapflow
 * emits `exists` for the CURRENTLY SELECTED mailbox and auto-idles wherever the last SELECT
 * landed, so a watch that selects INBOX once at attach is dead from the first cycle onward —
 * every cycle's folder work re-selects elsewhere and nothing ever re-selects INBOX. These tests
 * pin the three properties the fix consists of:
 *
 *  1. the wake fires ONLY for `exists` on INBOX — an event for any other folder (the visit's own
 *     writes, a passive folder left selected) is not a wake;
 *  2. `rearmWatch()` re-selects INBOX under the client's lock and starts IDLE explicitly —
 *     auto-idle's 15 s inactivity delay would otherwise sit inside every wake;
 *  3. before `watch()` and after its unwatch, `rearmWatch()` is a no-op — no SELECT on a
 *     connection nobody is listening to.
 *
 * A fake client rather than a live server, deliberately: the claim is about which commands the
 * ADAPTER issues and which events it forwards, both of which the fake records exactly. What a
 * fake cannot prove — that a real server's untagged EXISTS reaches a re-armed IDLE — is noted in
 * the slice report and was verified against the production provider directly, because GreenMail
 * is unavailable in this environment.
 */

type Listener = (data?: { path?: string }) => void;

function fakeClient() {
  const calls: string[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const client = {
    on(event: string, fn: Listener): void {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(event, set);
    },
    removeListener(event: string, fn: Listener): void {
      listeners.get(event)?.delete(fn);
    },
    async getMailboxLock(path: string): Promise<{ release: () => void }> {
      calls.push(`lock:${path}`);
      return { release: () => calls.push("release") };
    },
    async idle(): Promise<boolean> {
      calls.push("idle");
      return true;
    },
  };
  const emit = (event: string, data?: { path?: string }): void => {
    for (const fn of listeners.get(event) ?? []) fn(data);
  };
  const listenerCount = (event: string): number => listeners.get(event)?.size ?? 0;
  return { client, calls, emit, listenerCount };
}

/** One timer turn: the adapter asks for IDLE a turn after it is due (see the busy-guard cases). */
const aTurn = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

function adapterWith(client: unknown): ImapAdapter {
  const adapter = new ImapAdapter({
    host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
  });
  (adapter as unknown as { delimiter: string }).delimiter = "/"; // what connect() learns on a flat server
  (adapter as unknown as { client: unknown }).client = client;
  return adapter;
}

describe("watch — exists-on-INBOX, and nothing else", () => {
  it("selects INBOX under the lock and starts IDLE without waiting for auto-idle", async () => {
    const { client, calls } = fakeClient();
    const adapter = adapterWith(client);
    await adapter.watch(() => undefined);
    await aTurn();
    expect(calls).toEqual(["lock:INBOX", "release", "idle"]);
  });

  it("fires for exists on INBOX and for NOTHING else", async () => {
    const { client, emit, listenerCount } = fakeClient();
    const adapter = adapterWith(client);
    let wakes = 0;
    await adapter.watch(() => { wakes += 1; });

    // The visit's own folder work: another folder is selected, its events are not wakes.
    emit("exists", { path: "ohmail/History" });
    expect(wakes).toBe(0);

    // flags/expunge are DELIBERATELY not wake events — the worker's own STOREs and MOVEs emit
    // them, and counting echoes of our own writes as wakes spends the revisit budget on nothing.
    expect(listenerCount("flags")).toBe(0);
    expect(listenerCount("expunge")).toBe(0);

    // The real thing: INBOX grew.
    emit("exists", { path: "INBOX" });
    expect(wakes).toBe(1);

    // A payload-free event (no path) is not attributable to INBOX and must not wake.
    emit("exists", undefined);
    expect(wakes).toBe(1);
  });

  it("unwatch removes the listener and future exists events are silent", async () => {
    const { client, emit } = fakeClient();
    const adapter = adapterWith(client);
    let wakes = 0;
    const unwatch = await adapter.watch(() => { wakes += 1; });
    emit("exists", { path: "INBOX" });
    expect(wakes).toBe(1);
    await unwatch();
    emit("exists", { path: "INBOX" });
    expect(wakes).toBe(1);
  });
});

describe("rearmWatch — put the connection back where watch left it", () => {
  it("re-selects INBOX and restarts IDLE after the visit moved the selection", async () => {
    const { client, calls } = fakeClient();
    const adapter = adapterWith(client);
    await adapter.watch(() => undefined);
    await aTurn();
    calls.length = 0;
    await adapter.rearmWatch();
    await aTurn();
    expect(calls).toEqual(["lock:INBOX", "release", "idle"]);
  });

  it("is a no-op before watch() — nothing is listening, so nothing is selected", async () => {
    const { client, calls } = fakeClient();
    const adapter = adapterWith(client);
    await adapter.rearmWatch();
    expect(calls).toEqual([]);
  });

  it("is a no-op after unwatch — a detached listener earns no SELECTs", async () => {
    const { client, calls } = fakeClient();
    const adapter = adapterWith(client);
    const unwatch = await adapter.watch(() => undefined);
    await unwatch();
    calls.length = 0;
    await adapter.rearmWatch();
    expect(calls).toEqual([]);
  });
});

describe("rearmWatch — IDLE only on a connection nobody is using", () => {
  /**
   * PERF-026: the next pass's lease read sent LIST in the same turn the previous visit's re-arm
   * started IDLE; the IDLE queued behind the LIST and ahead of the read's LSUB, which then waited
   * 15 s for a heartbeat NOOP to break it. The client's own `connectionBusy()` (what its
   * auto-IDLE asks) is asked when the IDLE would start, and a busy connection declines.
   */
  it("declines IDLE while another caller's command sequence is in flight", async () => {
    const { client, calls } = fakeClient();
    let busy = false;
    const adapter = adapterWith({ ...client, connectionBusy: () => busy });
    await adapter.watch(() => undefined);
    await aTurn();
    calls.length = 0;
    await adapter.rearmWatch();
    busy = true;                       // the next pass sent its LIST before the IDLE went out
    await aTurn();
    expect(calls).toEqual(["lock:INBOX", "release"]);
  });

  it("starts IDLE a turn later on a free connection (the positive control)", async () => {
    const { client, calls } = fakeClient();
    const adapter = adapterWith({ ...client, connectionBusy: () => false });
    await adapter.watch(() => undefined);
    await aTurn();
    expect(calls).toEqual(["lock:INBOX", "release", "idle"]);
  });
});

describe("rearmWatch — the blind-window catch-up", () => {
  /**
   * A message that arrives between the visit's INBOX scan and the re-arm emits `exists` into the
   * wrong folder (or into nothing), and the re-arm's own SELECT absorbs it into a fresh baseline
   * WITHOUT emitting the public event — imapflow's SELECT handler seeds state silently. So the
   * re-arm itself must diff the SELECTed uidNext against what the last scan saw and ring the
   * callback. Without this, blind-window mail waits for the poll floor.
   */
  const seed = (adapter: ImapAdapter, uidValidity: string, uidNext: number): void => {
    (adapter as unknown as { lastInboxSeen: { uidValidity: string; uidNext: number } | null })
      .lastInboxSeen = { uidValidity, uidNext };
  };
  const mailbox = (client: unknown, uidValidity: bigint, uidNext: number): void => {
    (client as { mailbox?: unknown }).mailbox = { path: "INBOX", uidValidity, uidNext };
  };

  it("rings the wake when the re-arm SELECT shows INBOX grew past the last scan", async () => {
    const { client } = fakeClient();
    const adapter = adapterWith(client);
    let wakes = 0;
    await adapter.watch(() => { wakes += 1; });
    seed(adapter, "7", 41);
    mailbox(client, 7n, 43); // two messages arrived inside the blind window
    await adapter.rearmWatch();
    expect(wakes).toBe(1);
    // …and the baseline moved with it: the SAME growth must not ring twice.
    await adapter.rearmWatch();
    expect(wakes).toBe(1);
  });

  it("stays silent when nothing grew, and when UIDVALIDITY changed under the number", async () => {
    const { client } = fakeClient();
    const adapter = adapterWith(client);
    let wakes = 0;
    await adapter.watch(() => { wakes += 1; });

    seed(adapter, "7", 41);
    mailbox(client, 7n, 41); // unchanged
    await adapter.rearmWatch();
    expect(wakes).toBe(0);

    // A uidNext from a DIFFERENT epoch is not comparable — renumbering is handled by the scan's
    // own re-enumeration, and a wake here would be a guess dressed as a signal.
    mailbox(client, 8n, 99);
    await adapter.rearmWatch();
    expect(wakes).toBe(0);
  });

  it("stays silent before the first scan — there is no baseline to have grown from", async () => {
    const { client } = fakeClient();
    const adapter = adapterWith(client);
    let wakes = 0;
    await adapter.watch(() => { wakes += 1; });
    mailbox(client, 7n, 500);
    await adapter.rearmWatch();
    expect(wakes).toBe(0);
  });
});

describe("noop — the heartbeat puts IDLE back at once", () => {
  /**
   * The heartbeat's NOOP ends IDLE, and imapflow starts it again only after its 15 s auto-IDLE
   * delay: an arrival in that gap waited up to 15 s. After the NOOP the adapter asks for IDLE a
   * turn later, behind the same busy guard as the re-arm, and only while the watch rests on INBOX.
   */
  const withNoop = (extra: Record<string, unknown> = {}) => {
    const f = fakeClient();
    const client = {
      ...f.client,
      mailbox: { path: "INBOX" } as { path: string } | false,
      async noop(): Promise<void> { f.calls.push("noop"); },
      ...extra,
    };
    return { ...f, client };
  };

  it("after watch(), a NOOP is followed by IDLE a turn later", async () => {
    const { client, calls } = withNoop();
    const adapter = adapterWith(client);
    await adapter.watch(() => undefined);
    await aTurn();
    calls.length = 0;
    await adapter.noop();
    expect(calls).toEqual(["noop"]);
    await aTurn();
    expect(calls).toEqual(["noop", "idle"]);
  });

  it("asks no IDLE before watch(), after unwatch, when busy, or when INBOX is not selected", async () => {
    const before = withNoop();
    await adapterWith(before.client).noop();
    await aTurn();
    expect(before.calls).toEqual(["noop"]);

    const after = withNoop();
    const a = adapterWith(after.client);
    const unwatch = await a.watch(() => undefined);
    await unwatch();
    await aTurn();
    after.calls.length = 0;
    await a.noop();
    await aTurn();
    expect(after.calls).toEqual(["noop"]);

    let busy = false;
    const loaded = withNoop({ connectionBusy: () => busy });
    const b = adapterWith(loaded.client);
    await b.watch(() => undefined);
    await aTurn();
    loaded.calls.length = 0;
    await b.noop();
    busy = true;
    await aTurn();
    expect(loaded.calls).toEqual(["noop"]);

    const elsewhere = withNoop();
    const c = adapterWith(elsewhere.client);
    await c.watch(() => undefined);
    await aTurn();
    elsewhere.client.mailbox = { path: "ohmail/_meta" };
    elsewhere.calls.length = 0;
    await c.noop();
    await aTurn();
    expect(elsewhere.calls).toEqual(["noop"]);
  });

  it("a vanished expunge event is not a wake", async () => {
    const { client, emit } = withNoop();
    const adapter = adapterWith(client);
    let wakes = 0;
    await adapter.watch(() => { wakes += 1; });
    emit("expunge", { path: "INBOX", vanished: true } as { path: string });
    expect(wakes).toBe(0);
  });
});
