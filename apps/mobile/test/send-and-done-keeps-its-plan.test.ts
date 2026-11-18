/**
 * SEND + DONE KEEPS ITS PLAN ON THE PHONE — the release a confirmation runs is the one the mirror
 * reads at the RELEASE, on every road, and each release says its Undo once.
 *
 * Driven through the app's own `bootEngine` over the loopback mail server; the network is the
 * door's switch. Rows: PHONE-PRESS-FLUSH-DROPS-OTHER-KEYS-RESULTS,
 * SEND-DONE-CONFIRMED-DURING-ANOTHER-SEND-LOSES-ITS-UNDO, PHONE-OFFLINE-REPRESS-KEEPS-THE-FIRST-PRESS-PLAN,
 * SEND-AND-DONE-LATE-RELEASE-APPLIES-THE-PRESS-TIME-PLAN (the phone half).
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { sendAndDonePlanFor, type EntityReader } from "@ohmail/client-engine";
import { bootEngine, LOCAL_ENGINE_ORIGIN, type LocalEngineDoor, type MobileEngineDeps } from "../src/engine/boot";
import { installNetworkReader, networkNow, type NetworkReader } from "../src/net/network-door";
import { flushQueued, liveActions, type ToastOpts } from "../src/state/live";
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

/** One phone on the local door: with the switch off, the send step is refused as unreachable. */
async function scene(opts: { thread?: string } = {}) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage({
    ...dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }),
    threadId: opts.thread ?? null,
  });
  fake.addMessage(dto("m-2", { subject: "Lunch", from: { name: "Bo", address: "bo@fake.test" } }));
  const net = networkSwitch();
  installNetworkReader(net.reader);
  const door: LocalEngineDoor = {
    sessionToken: "launch-1",
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (networkNow() === "offline" && req.method === "POST" && /^\/drafts\/[^/]+\/send$/.test(url.pathname)) {
        await req.text();
        return new Response(JSON.stringify({ status: "failed", message: "the mail server could not be reached" }), {
          status: 409, headers: { "content-type": "application/json" },
        });
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
  const boot = await bootEngine(deps, { origin: LOCAL_ENGINE_ORIGIN, accountId: "acct-1", localEngine: door, network: networkNow });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.engine.start();
  const toasts: Array<{ say: string; opts?: ToastOpts }> = [];
  /* The Ohbox as presented: the raw mirror unless a case hides a row the way a routing rule does. */
  const shown: { reader: (() => EntityReader) | null } = { reader: null };
  const actions = liveActions({
    engine: boot.engine, toast: (m, opts) => toasts.push({ say: sayArg(m), ...(opts ? { opts } : {}) }), uuid, zone: "UTC",
    presented: () => shown.reader?.() ?? boot.engine.read(),
  });
  return { fake, net, engine: boot.engine, store: boot.store, actions, toasts, shown };
}

const wireMarks = (fake: ReturnType<typeof mailServer>): number =>
  fake.seen.filter((r) => r.method === "PATCH" && r.url === "/messages").length;
const failSends = (fake: ReturnType<typeof mailServer>, n: number): void => {
  for (let i = 0; i < n; i++) fake.failNextStatus("POST", "/drafts/", 500);
};
const unreadOf = (s: { engine: { read: () => { get: <T>(t: string, id: string) => T | undefined } } }, id: string) =>
  s.engine.read().get<EngineMessage>("message", id)?.unread;
const doneSaid = (toasts: ReadonlyArray<{ say: string; opts?: ToastOpts }>) =>
  toasts.filter((t) => t.say === Copy.toastSentAndDone);
const drafted = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.method === "POST" && r.url === "/drafts");
const rewritten = (fake: ReturnType<typeof mailServer>) => fake.seen.filter((r) => r.method === "PUT" && /^\/drafts\/[^/]+$/.test(r.url));
/** The mirror with one message routed out of the Ohbox, as a rule-presented row reads. */
const hiding = (raw: EntityReader, id: string): EntityReader => ({
  ...raw,
  list: <T,>(type: string) => (type === "message"
    ? (raw.list<T>(type) as unknown[]).filter((m) => (m as { id?: string }).id !== id)
    : raw.list<T>(type)) as T[],
  get: <T,>(type: string, x: string) => (type === "message" && x === id ? undefined : raw.get<T>(type, x)),
  entries: <T,>(type: string) => raw.entries<T>(type).filter((e) => !(type === "message" && e.id === id)),
} as unknown as EntityReader);
const settled = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("a Send + Done confirmed by another press's flush", () => {
  /** The press's flush confirmed m-1's Send + Done. The ledger still gets m-1 (row 20's ledger half). */
  it("lands in the reconnect flush's ledger as confirmed", async () => {
    const s = await scene();
    failSends(s.fake, 2);
    const first = await s.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true);
    expect(first.outcome).toBe("queued");
    failSends(s.fake, 1);
    expect((await s.actions.sendReply("m-2", "Gern.", false)).outcome).toBe("sent");
    const ledger = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(ledger.get(first.key!)?.status, "the other key's confirmation left no ledger entry").toBe("confirmed");
    s.store.close();
  }, 60_000);

  it("says Sent · marked done with its Undo once, on one road or the other", async () => {
    const s = await scene();
    failSends(s.fake, 2);
    const first = await s.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true);
    expect(first.outcome).toBe("queued");
    failSends(s.fake, 1);
    expect((await s.actions.sendReply("m-2", "Gern.", false)).outcome).toBe("sent");
    expect(unreadOf(s, "m-1"), "premise: the press's flush filed m-1").toBe(false);
    const ledger = await flushQueued(s.engine, s.actions.releaseConfirmed);
    const byFlush = ledger.get(first.key!)?.done ?? null;
    const said = [
      ...doneSaid(s.toasts),
      ...(byFlush && sayArg(byFlush.say) === Copy.toastSentAndDone ? [{ say: sayArg(byFlush.say), opts: byFlush.opts }] : []),
    ];
    expect(said.length, "the release filed m-1 and its sentence was said on no road").toBe(1);
    expect(typeof said[0]?.opts?.undo, "the sentence came without its Undo").toBe("function");
    expect(wireMarks(s.fake), "the release reached the wire more or less than once").toBe(1);
    expect(s.fake.deliveries(), "each send went exactly once").toHaveLength(2);
    s.store.close();
  }, 60_000);
});

describe("a Send + Done pressed again with no network", () => {
  it("over a waiting plain Send, files the source when the send goes", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "The same reply.", false)).outcome).toBe("queued");
    expect((await s.actions.sendReply("m-1", "The same reply.", false, null, null, [], true)).outcome).toBe("queued");
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries(), "not exactly one delivery").toHaveLength(1);
    expect(unreadOf(s, "m-1"), "the re-press's Send + Done was dropped for the first press's plain Send").toBe(false);
    expect(wireMarks(s.fake)).toBe(1);
    expect(drafted(s.fake), "the re-press wrote a second draft row").toHaveLength(1);
    expect(rewritten(s.fake).length, "the resume rewrote the row more than once").toBeLessThanOrEqual(1);
    s.store.close();
  }, 60_000);

  it("a plain Send over a waiting Send + Done disarms the release", async () => {
    const s = await scene();
    s.net.set("offline");
    expect((await s.actions.sendReply("m-1", "The same reply.", false, null, null, [], true)).outcome).toBe("queued");
    expect((await s.actions.sendReply("m-1", "The same reply.", false)).outcome).toBe("queued");
    s.net.set("online");
    const ledger = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries(), "not exactly one delivery").toHaveLength(1);
    expect(unreadOf(s, "m-1"), "the plain re-press still filed the source").toBe(true);
    expect(wireMarks(s.fake)).toBe(0);
    expect([...ledger.values()].every((o) => o.done === null)).toBe(true);
    expect(drafted(s.fake)).toHaveLength(1);
    expect(rewritten(s.fake).length).toBeLessThanOrEqual(1);
    s.store.close();
  }, 60_000);

  it("CONTROL: a plain Send pressed twice files nothing and goes once", async () => {
    const s = await scene();
    s.net.set("offline");
    await s.actions.sendReply("m-1", "The same reply.", false);
    await s.actions.sendReply("m-1", "The same reply.", false);
    s.net.set("online");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(unreadOf(s, "m-1")).toBe(true);
    expect(wireMarks(s.fake)).toBe(0);
    s.store.close();
  }, 60_000);
});

describe("a Send + Done released later reads the mirror at the release", () => {
  it("a source filed elsewhere after the press is not marked read when the send goes", async () => {
    const s = await scene();
    failSends(s.fake, 2);
    expect((await s.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("queued");
    const moved = await s.engine.mutate({ kind: "move", messageId: "m-1", folder: "ohmail/Receipts" });
    expect(moved.status).toBe("confirmed");
    expect(sendAndDonePlanFor(s.engine.read(), "m-1"), "premise: the filed source left the Ohbox").toBeNull();
    const marksBefore = wireMarks(s.fake);
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(wireMarks(s.fake) - marksBefore, "the press-time plan marked read a message filed elsewhere after the press").toBe(0);
    expect(unreadOf(s, "m-1")).toBe(true);
    s.store.close();
  }, 60_000);

  it("a member that arrived after the press stays unread, and its conversation stays in New", async () => {
    const s = await scene({ thread: "T" + "1" });
    failSends(s.fake, 2);
    expect((await s.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("queued");
    s.fake.addMessage({ ...dto("m-3", { subject: "Re: Invoice 12", date: "2026-08-19T09:00:00Z" }), threadId: "T" + "1" });
    await s.engine.syncOnce();
    expect(sendAndDonePlanFor(s.engine.read(), "m-1")?.messageIds.sort(), "premise: the new member joined the row").toEqual(["m-1", "m-3"]);
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(unreadOf(s, "m-1")).toBe(false);
    expect(unreadOf(s, "m-3"), "the release read a message the press never saw").toBe(true);
    expect(sendAndDonePlanFor(s.engine.read(), "m-3")?.section, "the conversation left New").toBe("new");
    s.store.close();
  }, 60_000);

  it("a source the Ohbox on screen no longer shows is not filed, though the raw mirror still holds it", async () => {
    const s = await scene();
    failSends(s.fake, 2);
    expect((await s.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("queued");
    s.shown.reader = () => hiding(s.engine.read(), "m-1");
    expect(sendAndDonePlanFor(s.engine.read(), "m-1"), "premise: the raw mirror still offers it").not.toBeNull();
    const ledger = await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(wireMarks(s.fake), "the release read the raw mirror, not the Ohbox presented").toBe(0);
    expect([...ledger.values()][0]?.done ?? null).toBeNull();
    s.store.close();
  }, 60_000);

  it("the Undo said after a late release puts the source back unread", async () => {
    const s = await scene();
    failSends(s.fake, 2);
    expect((await s.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("queued");
    const [o] = [...(await flushQueued(s.engine, s.actions.releaseConfirmed)).values()];
    expect(o?.done && sayArg(o.done.say)).toBe(Copy.toastSentAndDone);
    expect(unreadOf(s, "m-1")).toBe(false);
    o!.done!.opts!.undo!();
    await settled();
    expect(unreadOf(s, "m-1"), "Undo did not put the source back").toBe(true);
    expect(sendAndDonePlanFor(s.engine.read(), "m-1")?.section).toBe("new");
    s.store.close();
  }, 60_000);

  it("CONTROL: an unchanged source is filed once when the send goes later", async () => {
    const s = await scene();
    failSends(s.fake, 2);
    expect((await s.actions.sendReply("m-1", "Donnerstag passt.", false, null, null, [], true)).outcome).toBe("queued");
    await flushQueued(s.engine, s.actions.releaseConfirmed);
    expect(s.fake.deliveries()).toHaveLength(1);
    expect(wireMarks(s.fake)).toBe(1);
    expect(unreadOf(s, "m-1")).toBe(false);
    s.store.close();
  }, 60_000);
});
