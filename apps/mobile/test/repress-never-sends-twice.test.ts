/**
 * ONE INTENT, ONE KEY, ONE DELIVERY, while any entry of that intent is queued, in a running
 * flush's batch, or on the wire (PRE-1). The flush lifted its whole batch
 * off the queue before the first dispatch and the send in the air was in no collection a re-press
 * read, so a re-press minted a second key: 3 deliveries for 2 replies, 2 for 1.
 * Deciding lines: `takeTurn`'s skip and the at-turn splice (engine.ts), the same-key wire arm in
 * `supersedeQueued`, the `inFlightMutations()` read in `dispatchSend` (live.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityReader } from "@ohmail/client-engine";
import { bootEngine, LOCAL_ENGINE_ORIGIN, type LocalEngineDoor, type MobileEngineDeps } from "../src/engine/boot";
import { installNetworkReader, networkNow, type NetworkReader } from "../src/net/network-door";
import { flushQueued, liveActions, reconnectFlushDue, type ToastOpts } from "../src/state/live";
import { Copy } from "../src/copy";
import { sayArg } from "../src/refusal";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();

afterEach(() => { installNetworkReader(null); });

function networkSwitch(): { reader: NetworkReader; set(s: "online" | "offline"): void } {
  let state: "online" | "offline" = "online";
  const listeners = new Set<(r: unknown) => void>();
  return {
    reader: { read: () => state, subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; } },
    set(s) { state = s; for (const l of [...listeners]) l(s); },
  };
}

type SendFate = "drop" | "refuse";

/**
 * One phone on the local door. Offline, the send step answers the unreachable 409. `nextSend`
 * arms the next send request: `drop` is a transport failure after the row was made, `refuse` the
 * server's definite `failed`, which the reservation then answers for that key for ever, as the
 * real route does. `gate` holds that request until released.
 */
async function scene() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  fake.addMessage(dto("m-2", { subject: "Lunch", from: { name: "Bo", address: "bo@fake.test" } }));
  fake.addMessage(dto("m-3", { subject: "Keys", from: { name: "Cy", address: "cy@fake.test" } }));
  const net = networkSwitch();
  installNetworkReader(net.reader);
  const refused = new Set<string>();
  const armed: Array<{ fate: SendFate; gate: Promise<void> }> = [];
  /** Every send request that reached the door, in order: the draft row and its key. */
  const wire: Array<{ row: string; key: string | null }> = [];
  const failed = (message: string) => new Response(JSON.stringify({ status: "failed", message }), {
    status: 409, headers: { "content-type": "application/json" },
  });
  const door: LocalEngineDoor = {
    sessionToken: "launch-1",
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const send = req.method === "POST" ? /^\/drafts\/([^/]+)\/send$/.exec(url.pathname) : null;
      if (send) {
        const key = req.headers.get("idempotency-key");
        wire.push({ row: send[1]!, key });
        if (networkNow() === "offline") { await req.text(); return failed("the mail server could not be reached"); }
        if (key !== null && refused.has(key)) { await req.text(); return failed("A prior send under this key failed."); }
        const a = armed.shift();
        if (a) {
          await req.text();
          await a.gate;
          if (a.fate === "drop") throw new TypeError("fetch failed");
          if (key !== null) refused.add(key);
          return failed("The mail server refused the message.");
        }
      }
      const body = req.method === "GET" ? undefined : await req.text();
      return fetch(`${origin}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    },
  };
  const world = sqlWorld();
  const deps: MobileEngineDeps = {
    openExecutor: world.open, deleteDatabase: world.drop, uuid,
    fetch: async () => { throw new Error("the global transport was used on the standalone door"); },
  };
  const toasts: Array<{ say: string; opts?: ToastOpts }> = [];
  const boot = async () => {
    const b = await bootEngine(deps, { origin: LOCAL_ENGINE_ORIGIN, accountId: "acct-1", localEngine: door, network: networkNow });
    if (b.kind !== "ready") throw new Error("boot refused");
    await b.engine.start();
    const shown: { reader: (() => EntityReader) | null } = { reader: null };
    const actions = liveActions({
      engine: b.engine, toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ? { opts } : {}) }), uuid, zone: "UTC",
      presented: () => shown.reader?.() ?? b.engine.read(),
    });
    return { engine: b.engine, store: b.store, actions };
  };
  const first = await boot();
  return {
    fake, net, wire, toasts, ...first, boot,
    nextSend(fate: SendFate): () => void {
      let release!: () => void;
      armed.push({ fate, gate: new Promise<void>((r) => { release = r; }) });
      return release;
    },
  };
}
type Scene = Awaited<ReturnType<typeof scene>>;

const sends = (s: Scene) => s.wire;
/** The draft row the fake made for a reply to `parent`, in creation order. */
const rowsFor = (s: Scene, parent: string) =>
  s.fake.draftRows().filter((d) => (d as { inReplyToMessageId?: unknown }).inReplyToMessageId === parent).map((d) => String(d.id));
/** THE IDENTITY THE ROAD IS ABOUT: the distinct keys that reached the wire for one reply. */
const keysOnTheWire = (s: Scene, parent: string) => {
  const rows = new Set(rowsFor(s, parent));
  return new Set(s.wire.filter((w) => rows.has(w.row)).map((w) => w.key));
};
const deliveredFor = (s: Scene, parent: string) => {
  const keys = keysOnTheWire(s, parent);
  return s.fake.deliveries().filter((k) => keys.has(k));
};
async function until(cond: () => boolean, what: string): Promise<void> {
  const by = Date.now() + 10_000;
  while (!cond() && Date.now() < by) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error(`never reached: ${what}`);
}
const replySent = sayArg(Copy.replySent);
const alreadyWent = sayArg(Copy.unsavedSendAlreadyWent);
/** The n-th send request since the network came back has reached the door (it may be held there). */
const untilWire = (s: Scene, n: number, what: string) => until(() => s.wire.length >= n, what);

/** Two replies queued offline: m-2 first, then m-1. */
async function twoQueued(s: Scene, m1 = "Reply to Ada.") {
  s.net.set("offline");
  expect((await s.actions.sendReply("m-2", "First reply, to Bo.", false)).outcome).toBe("queued");
  expect((await s.actions.sendReply("m-1", m1, false)).outcome).toBe("queued");
  s.net.set("online");
  return s.engine.pendingMutations().map((p) => p.key);
}

describe("a re-press while a flush carries the reply", () => {
  it("A — in the batch behind the send on the wire: the reply is delivered once", async () => {
    const s = await scene();
    const keysBefore = await twoQueued(s);
    expect(keysBefore).toHaveLength(2);
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the first send on the wire");
    // The batch tail is still a queued verb, and the head is on the wire.
    const mid = s.engine.pendingMutations().map((p) => p.key);
    expect(mid, "the batch tail is invisible mid-flush").toEqual([keysBefore[1]]);
    expect(s.engine.inFlightMutations().map((p) => p.key)).toEqual([keysBefore[0]]);
    // The world layer's reconnect trigger: every key mid-flush was tried, so no hot loop.
    expect(reconnectFlushDue(mid, new Set(keysBefore), false)).toBe(false);
    const again = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    await flush;
    expect((await again).outcome).toBe("sent");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries(), "the reply went twice").toHaveLength(2);
    expect(keysOnTheWire(s, "m-1"), "a second key reached the wire").toEqual(new Set([keysBefore[1]]));
    expect(rowsFor(s, "m-1"), "a second row was made").toHaveLength(1);
    s.store.close();
  }, 60_000);

  it("B — that is itself on the wire: the reply is delivered once", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    s.net.set("online");
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the send on the wire");
    const again = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    await flush;
    expect((await again).outcome).toBe("sent");
    expect(s.fake.deliveries(), "the reply went twice").toHaveLength(1);
    expect(keysOnTheWire(s, "m-1").size, "a second key reached the wire").toBe(1);
    expect(rowsFor(s, "m-1")).toHaveLength(1);
    expect(s.engine.pendingMutations()).toHaveLength(0);
    s.store.close();
  }, 60_000);

  it("C — CONTROL: the same re-press before the flush resumes the standing key", async () => {
    const s = await scene();
    await twoQueued(s);
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("sent");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(2);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    s.store.close();
  }, 60_000);

  it("D — the web's road (the caller passes the standing key): one create and one send per reply", async () => {
    const s = await scene();
    const keys = await twoQueued(s);
    const k1 = s.engine.pendingMutations().find((p) => p.key === keys[1])!;
    const createsBefore = s.fake.seen.filter((r) => r.method === "POST" && r.url === "/drafts").length;
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = s.engine.flushPending();
    await untilWire(s, 1, "the first send on the wire");
    const again = s.engine.mutate(k1.mutation, { key: k1.key });
    release();
    await flush;
    expect((await again).status).toBe("confirmed");
    await s.engine.flushPending();
    expect(s.fake.deliveries()).toHaveLength(2);
    expect(s.fake.seen.filter((r) => r.method === "POST" && r.url === "/drafts").length - createsBefore,
      "the re-press made a row of its own").toBe(0);
    expect(s.fake.seen.filter((r) => r.method === "POST" && /\/send$/.test(r.url)), "a wasted send request").toHaveLength(2);
    s.store.close();
  }, 60_000);

  it("E — a third press while the second waits its turn: still one delivery under one key", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    s.net.set("online");
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the send on the wire");
    const second = s.actions.sendReply("m-1", "Reply to Ada.", false);
    const third = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    await flush;
    await Promise.all([second, third]);
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    expect(rowsFor(s, "m-1")).toHaveLength(1);
    s.store.close();
  }, 60_000);

  it("F — two flushes and a Try again race over three queued replies: every key goes once", async () => {
    const s = await scene();
    s.net.set("offline");
    for (const [id, body] of [["m-1", "To Ada."], ["m-2", "To Bo."], ["m-3", "To Cy."]] as const) {
      expect((await s.actions.sendReply(id, body, false)).outcome).toBe("queued");
    }
    s.net.set("online");
    const tail = s.engine.pendingMutations()[2]!;
    const release = s.fake.holdNext("POST", "/drafts/");
    const a = s.engine.flushPending();
    const b = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the head on the wire");
    const c = s.engine.retryQueued(tail.id);
    release();
    await Promise.all([a, b, c]);
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(3);
    for (const parent of ["m-1", "m-2", "m-3"]) {
      const rows = new Set(rowsFor(s, parent));
      expect(s.wire.filter((w) => rows.has(w.row)).length, `${parent} went to the wire twice`).toBe(1);
    }
    s.store.close();
  }, 60_000);
});

describe("a re-press over a send on the wire, by how the wire answers", () => {
  it("G — confirmed, newer words: one delivery, said as the earlier version", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    s.net.set("online");
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the send on the wire");
    const again = s.actions.sendReply("m-1", "Reply to Ada, with the figures.", false);
    release();
    await flush;
    expect((await again).outcome).toBe("sent");
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    expect(s.toasts.at(-1)?.say, "the newer words were announced as sent").toBe(sayArg(Copy.replyEarlierWent));
    s.store.close();
  }, 60_000);

  it("H — a transport failure, newer words: the older drops, the newer words go once", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    s.net.set("online");
    const release = s.nextSend("drop");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the send on the wire");
    const said = s.toasts.length;
    const again = s.actions.sendReply("m-1", "Reply to Ada, with the figures.", false);
    release();
    const outcomes = await flush;
    expect((await again).outcome).toBe("sent");
    const after = await flushQueued(s.engine, s.actions.releaseConfirmed);
    // TO ITS END: the key's one sentence is the newer entry's, and nothing waits for it.
    expect(s.toasts.slice(said).map((t) => t.say), "the key was said more than once, or not by the newer press").toEqual([replySent]);
    expect([...after.keys()], "a later flush still answered for the key").toEqual([]);
    expect(s.engine.inFlightMutations()).toHaveLength(0);
    expect(s.engine.hasLateResults(), "an answer for the key is still waiting").toBe(false);
    const rows = new Set(rowsFor(s, "m-1"));
    expect(s.wire.filter((w) => rows.has(w.row)), "the older send was queued again beside the newer").toHaveLength(2);
    const delivered = deliveredFor(s, "m-1");
    expect(delivered).toHaveLength(1);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    expect(rowsFor(s, "m-1"), "one POST /drafts for the intent").toHaveLength(1);
    expect(s.engine.pendingMutations(), "the dropped older send was queued again").toHaveLength(0);
    expect([...outcomes.values()].map((o) => o.status), "the flush said 'not sent' over a reply still going").toEqual([]);
    // The words that went are the newer ones: the resume wrote them before sending.
    expect(s.fake.draftRows().find((d) => rows.has(String(d.id)))?.body).toBe("Reply to Ada, with the figures.");
    s.store.close();
  }, 60_000);

  it("I — refused: nothing is delivered, and the next press goes once under a fresh key", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    s.net.set("online");
    const release = s.nextSend("refuse");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the send on the wire");
    const again = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    await flush;
    expect((await again).outcome).toBe("failed");
    expect(s.fake.deliveries(), "a refused send was delivered").toHaveLength(0);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("sent");
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(keysOnTheWire(s, "m-1").size, "two keys: the spent one and the fresh one").toBe(2);
    s.store.close();
  }, 60_000);
});

/** The optimistic Sent copies the mirror shows, by the header they were made for. */
const sentCopies = (s: Scene) => s.engine.read().list<{ folder?: string; messageIdHeader?: string }>("message")
  .filter((x) => x.folder === "Sent").map((x) => x.messageIdHeader);

describe("a live press re-pressed while it is on the wire", () => {
  it("a transport failure: the first press says nothing, the newer says sent, nothing waits", async () => {
    const s = await scene();
    const release = s.nextSend("drop");
    const first = s.actions.sendReply("m-1", "Reply to Ada.", false);
    await untilWire(s, 1, "the live send on the wire");
    const again = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    const [r1, r2] = await Promise.all([first, again]);
    const after = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.toasts.map((t) => t.say), "the key ended on a sentence that is not the newer press's").toEqual([replySent]);
    expect([r1.outcome, r2.outcome]).toEqual(["superseded", "sent"]);
    expect(deliveredFor(s, "m-1")).toHaveLength(1);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    expect([...after.keys()]).toEqual([]);
    expect(s.engine.pendingMutations()).toHaveLength(0);
    expect(s.engine.inFlightMutations()).toHaveLength(0);
    expect(s.engine.hasLateResults()).toBe(false);
    s.store.close();
  }, 60_000);

  it("confirmed: one delivery, one Sent copy, and every sentence said is true", async () => {
    const s = await scene();
    const release = s.fake.holdNext("POST", "/drafts/");
    const first = s.actions.sendReply("m-1", "Reply to Ada.", false);
    await untilWire(s, 1, "the live send on the wire");
    const again = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    const [r1, r2] = await Promise.all([first, again]);
    // One key, one speaker: the newer press resumed a key the server had already sent, and says so.
    expect([r1.outcome, r2.outcome]).toEqual(["superseded", "sent"]);
    expect(deliveredFor(s, "m-1")).toHaveLength(1);
    expect(s.toasts.map((t) => t.say)).toEqual([alreadyWent]);
    expect(sentCopies(s), "one delivery painted as two Sent copies").toHaveLength(1);
    s.store.close();
  }, 60_000);

  it("the flush road, confirmed: one Sent copy for the one delivery", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    s.net.set("online");
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the send on the wire");
    const again = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    await flush;
    expect((await again).outcome).toBe("sent");
    expect(deliveredFor(s, "m-1")).toHaveLength(1);
    expect(sentCopies(s), "one delivery painted as two Sent copies").toHaveLength(1);
    s.store.close();
  }, 60_000);
});

describe("the same words again after the send went", () => {
  it("a new key inside the server's content claim says already sent, never 'try again'", async () => {
    const s = await scene();
    s.fake.setContentClaim(true);
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("sent");
    const said = s.toasts.length;
    const again = await s.actions.sendReply("m-1", "Reply to Ada.", false);
    expect(again.outcome).toBe("failed");
    expect(s.fake.duplicates(), "the second press did not reach the content claim").toHaveLength(1);
    expect(s.toasts.slice(said).map((t) => t.say)).toEqual([alreadyWent]);
    expect(s.fake.deliveries()).toHaveLength(1);
    s.store.close();
  }, 60_000);

  // A first send the server holds pending or could not confirm may still not go: claim no delivery.
  for (const status of ["pending", "unverified"]) {
    it(`the claim names a first send that is ${status}: check Sent first, never 'already sent'`, async () => {
      const s = await scene();
      s.fake.setContentClaim(true, status);
      await s.actions.sendReply("m-1", "Reply to Ada.", false);
      const said = s.toasts.length;
      expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("failed");
      expect(s.toasts.slice(said).map((t) => t.say)).toEqual([sayArg(Copy.replyUnverifiedAgain)]);
      expect(s.fake.deliveries()).toHaveLength(1);
      s.store.close();
    }, 60_000);
  }
});

describe("Cancel and a kill on the same seam", () => {
  it("Cancel on the batch tail withdraws it: skipped, and gone after a restart", async () => {
    const s = await scene();
    const keys = await twoQueued(s);
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the head on the wire");
    expect(await s.actions.withdrawSend(keys[1]!)).toBe("withdrawn");
    release();
    await flush;
    expect(s.fake.deliveries()).toEqual([keys[0]]);
    expect(keysOnTheWire(s, "m-1").size, "the withdrawn send reached the wire").toBe(0);
    s.store.close();
    const after = await s.boot();
    expect(after.engine.pendingMutations(), "a withdrawn send came back after a restart").toHaveLength(0);
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(1);
    after.store.close();
  }, 60_000);

  it("Cancel on the send on the wire withdraws nothing and it goes once", async () => {
    const s = await scene();
    const keys = await twoQueued(s);
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the head on the wire");
    expect(await s.actions.withdrawSend(keys[0]!)).toBe("on_the_wire");
    release();
    await flush;
    expect(deliveredFor(s, "m-2")).toHaveLength(1);
    s.store.close();
  }, 60_000);

  it("a kill while the re-press is on the wire: one row under the key comes back, with its row, and goes once", async () => {
    const s = await scene();
    const keys = await twoQueued(s);
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the head on the wire");
    void s.actions.sendReply("m-1", "Reply to Ada.", false);
    await until(() => s.engine.pendingMutations().length === 0, "the tail retired by the re-press");
    // Armed only once the held head has reached the SERVER, or the hang takes the head instead.
    await until(() => s.fake.seen.some((r) => /\/send$/.test(r.url)), "the head at the server");
    s.fake.hangNext("POST", "/drafts/");
    release();
    await untilWire(s, 2, "the re-press on the wire");
    // The kill: nothing in this session is awaited past this point.
    void flush.catch(() => undefined);
    s.store.close();
    const after = await s.boot();
    const rows = after.engine.pendingMutations().filter((p) => p.key === keys[1]);
    expect(rows, "the kill left two rows under the key, or none").toHaveLength(1);
    expect((rows[0] as { createdRow?: unknown }).createdRow, "the restored row lost the row it made").toBeDefined();
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    expect(deliveredFor(s, "m-1")).toHaveLength(1);
    expect(rowsFor(s, "m-1")).toHaveLength(1);
    after.store.close();
  }, 60_000);
});

/**
 * REPRESS-DURING-A-FLUSH-SENDS-TWICE, both entries the row names: the reconnect
 * flush, and the launch replay after a kill. Counted at the transport: deliveries and the keys
 * that reached the wire for the re-pressed reply.
 */
describe("REPRESS-DURING-A-FLUSH-SENDS-TWICE", () => {
  it("the reconnect flush: re-pressing both replies mid-flush delivers two", async () => {
    const s = await scene();
    await twoQueued(s);
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the head on the wire");
    const onWire = s.actions.sendReply("m-2", "First reply, to Bo.", false);
    const behind = s.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    await flush;
    await Promise.all([onWire, behind]);
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries(), "a re-press delivered a reply twice").toHaveLength(2);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    expect(keysOnTheWire(s, "m-2").size).toBe(1);
    s.store.close();
  }, 60_000);

  it("the launch replay after a kill: re-pressing both replies mid-replay delivers two", async () => {
    const s = await scene();
    await twoQueued(s);
    s.store.close();
    const after = await s.boot();
    expect(after.engine.pendingMutations(), "the kill lost the queue").toHaveLength(2);
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(after.engine, after.actions.releaseConfirmed);
    await untilWire(s, 1, "the restored head on the wire");
    const onWire = after.actions.sendReply("m-2", "First reply, to Bo.", false);
    const behind = after.actions.sendReply("m-1", "Reply to Ada.", false);
    release();
    await flush;
    await Promise.all([onWire, behind]);
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    expect(s.fake.deliveries(), "a re-press delivered a reply twice").toHaveLength(2);
    expect(keysOnTheWire(s, "m-1").size).toBe(1);
    expect(keysOnTheWire(s, "m-2").size).toBe(1);
    after.store.close();
  }, 60_000);
});

/** The one-key fix, step 1: the LOW rows on this seam, read at the base. */
describe("the LOW rows beside it", () => {
  for (const [label, later] of [["a day", 25 * 60 * 60 * 1000], ["eight days", 8 * 24 * 60 * 60 * 1000]] as const) it(`a reply replayed ${label} later goes once under its key, and nothing is kept back`, async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    const [key] = s.engine.pendingMutations().map((p) => p.key);
    s.net.set("online");
    s.store.close();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + later);
      const after = await s.boot();
      await flushQueued(after.engine, after.actions.releaseConfirmed);
      expect({ delivered: deliveredFor(s, "m-1").length, keys: [...keysOnTheWire(s, "m-1")], kept: after.engine.abandoned().length },
        "a day-old reply was held back, or went under a second key").toEqual({ delivered: 1, keys: [key], kept: 0 });
      after.store.close();
    } finally { vi.useRealTimers(); }
  }, 60_000);

  it("the same words pressed OFFLINE over a reply waiting a day go once when the network is back", async () => {
    const s = await scene();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      s.net.set("offline");
      expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
      const [key] = s.engine.pendingMutations().map((p) => p.key);
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
      expect(s.engine.pendingMutations().map((p) => p.key), "the press queued a second send").toEqual([key]);
      s.net.set("online");
      await flushQueued(s.engine, s.actions.releaseConfirmed);
      expect({ delivered: deliveredFor(s, "m-1").length, kept: s.engine.abandoned().length }).toEqual({ delivered: 1, kept: 0 });
      s.store.close();
    } finally { vi.useRealTimers(); }
  }, 60_000);

  it("a new mail with no row waiting a day goes once when the network is back", async () => {
    const s = await scene();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const mail = () => s.actions.sendNew("mb-1", [{ name: null, address: "bo@fake.test" }], "Hello", "Hello Bo.");
      s.net.set("offline");
      await mail();
      vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
      s.net.set("online");
      await flushQueued(s.engine, s.actions.releaseConfirmed);
      expect({ delivered: s.fake.deliveries().length, kept: s.engine.abandoned().length },
        "the new mail was held back, or went twice").toEqual({ delivered: 1, kept: 0 });
      s.store.close();
    } finally { vi.useRealTimers(); }
  }, 60_000);

  it("REPRESS-OFFLINE-REPLY-SENDS-THE-EARLIER-WORDS: words A pressed offline, edited to B and pressed offline, goes once with B", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Words A.", false)).outcome).toBe("queued");
    expect((await s.actions.sendReply("m-1", "Words B, edited.", false)).outcome).toBe("queued");
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    const rows = new Set(rowsFor(s, "m-1"));
    const went = s.fake.draftRows().filter((d) => rows.has(String(d.id)) && (d as { status?: string }).status === "sent").map((d) => (d as { body?: string }).body);
    expect({ delivered: deliveredFor(s, "m-1").length, went }, "the earlier words went, or twice").toEqual({ delivered: 1, went: ["Words B, edited."] });
    s.store.close();
  }, 60_000);

  it("a new reply after a restart does not join a confirmed send kept for its echo", async () => {
    const s = await scene();
    expect((await s.actions.sendReply("m-1", "First reply.", false)).outcome).toBe("sent");
    const first = s.wire[s.wire.length - 1]!;
    s.net.set("offline");
    await s.actions.sendReply("m-2", "Placeholder to Bo.", false);
    // The first reply's row as the engine keeps it for its echo: same key, its row, confirmed.
    const [row] = s.engine.read().list("outbox_entry") as Array<Record<string, unknown> & { id: string; mutation: Record<string, unknown> }>;
    const kept = { ...row!, key: first.key, mutation: { ...row!.mutation, inReplyTo: "m-1", body: "First reply." }, createdRow: { id: first.row, revision: null }, confirmed: true };
    await s.store.commitLocal([{ type: "outbox_entry", id: row!.id, entity: kept }] as never, [] as never);
    s.store.close();
    const after = await s.boot();
    expect(after.engine.pendingMutations().some((p) => p.key === first.key && (p as { confirmed?: true }).confirmed === true), "premise: the kept send is restored").toBe(true);
    await after.actions.sendReply("m-1", "A second, new reply about the figures.", false);
    s.net.set("online");
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    await flushQueued(after.engine, after.actions.releaseConfirmed);
    const rows = new Set(rowsFor(s, "m-1"));
    const went = s.fake.draftRows().filter((d) => rows.has(String(d.id)) && (d as { status?: string }).status === "sent").map((d) => (d as { body?: string }).body).sort();
    expect({ delivered: deliveredFor(s, "m-1").length, went }, "the new reply joined a delivered key and never went")
      .toEqual({ delivered: 2, went: ["A second, new reply about the figures.", "First reply."] });
    after.store.close();
  }, 60_000);

  it("KILL-BETWEEN-MARK-AND-DROP-LOSES-THE-EARLIER-WORDS-SENTENCE: the replay says the earlier words went", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "Reply to Ada.", false)).outcome).toBe("queued");
    s.net.set("online");
    const release = s.fake.holdNext("POST", "/drafts/");
    const flush = flushQueued(s.engine, s.actions.releaseConfirmed);
    await untilWire(s, 1, "the send on the wire");
    void s.actions.sendReply("m-1", "Reply to Ada, with the figures.", false);
    await until(() => s.engine.pendingMutations().length + s.engine.inFlightMutations().length >= 2, "the re-press marked the send on the wire");
    void flush.catch(() => undefined);
    s.store.close();
    release();
    const after = await s.boot();
    const outcomes = await flushQueued(after.engine, after.actions.releaseConfirmed);
    const o = [...outcomes.values()].find((x) => x.kind === "mail_send");
    expect({ deliveries: deliveredFor(s, "m-1").length, status: o?.status, earlierWent: o?.earlierWent },
      "the replay's sentence lost the earlier words").toEqual({ deliveries: 1, status: "confirmed", earlierWent: true });
    after.store.close();
  }, 60_000);
});
