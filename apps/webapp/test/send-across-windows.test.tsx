/** @vitest-environment jsdom */
/**
 * A WAITING SEND HAS ONE OWNER, AND EVERY WINDOW READS IT (the cross-window send fix, the shell
 * half). Windows are engines over IndexedDB stores on ONE disk with ONE injected Web Locks registry
 * (jsdom has none, so an uninjected probe measures the branch no browser takes), over the real
 * HttpAdapter and a server that keeps one reservation per key. Each case reads the row's owner off
 * the disk first. The reviewers' two-window probes are the acceptance: VERIFY-026-SEND-RECORD-2's
 * cross-window Cancel above all, and the window opened before the press.
 */
/* @reads: packages/app-logic/src/writing/mail-send.ts */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, OhmailEngine, OUTBOX_TYPE } from "@ohmail/client-engine";
import type { EngineLocks, IndexedDbMirrorStore, MirrorStore } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { dto, listen, mailServer } from "../../mobile/test/helpers/mail-server";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const WORDS = "Thanks, Ada.";
let roots: Root[] = [];
const settle = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };

async function idb(): Promise<void> {
  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const fake = createRequire(resolve("packages/client-engine/package.json"))("fake-indexeddb") as { IDBFactory: new () => IDBFactory; IDBKeyRange: unknown };
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fake.IDBKeyRange;
}
/** One browser's Web Locks, shared by every window; `close` is a tab going away. */
function lockRegistry() {
  const held = new Set<string>();
  const api: EngineLocks = {
    async request(name, _o, cb) { held.add(name); return cb({ name }); },
    async query() { return { held: [...held].map((name) => ({ name })) }; },
  };
  return { api, close: (e: OhmailEngine) => { held.delete(ownerOf(e)!); } };
}
const ownerOf = (e: OhmailEngine): string | null => (e as unknown as { ownerName: string | null }).ownerName;

const replyTo = (body: string) => ({ kind: "mail_send", inReplyTo: "m-1", body, subject: "Re: Invoice", to: [{ name: "Ada", address: "ada@fake.test" }], mailboxId: "mb-1" });
const forwardOf = (body: string) => ({ kind: "mail_send", inReplyTo: null, forwardOf: "m-1", body, subject: "Fwd: Invoice", to: [{ name: null, address: "cy@fake.test" }], mailboxId: "mb-1" });

async function world(locks: EngineLocks | null) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice", from: { name: "Ada", address: "ada@fake.test" } }));
  const net = { offline: false };
  // The browser's own word on the network, which a claim reads: offline sends nothing, no wire fact.
  Object.defineProperty(window.navigator, "onLine", { get: () => !net.offline, configurable: true });
  const engine = (store: MirrorStore, tab: { dead: boolean }) => new OhmailEngine({ store, locks,
    adapter: new HttpAdapter({ baseUrl: origin, fetch: (u: string, i?: RequestInit) => (tab.dead || (net.offline && !String(u).includes("/sync")) ? Promise.reject(new TypeError("fetch failed")) : fetch(u, i)) } as never) });
  const keys = (): number => new Set(w.fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/send")).map((r) => r.key)).size;
  const w = { fake, net, engine, keys };
  return w;
}

type Surface = Awaited<ReturnType<typeof surface>>;
async function surface(engine: OhmailEngine) {
  const { useMailSend, replyDockState } = await import("@ohmail/app-logic/writing/mail-send");
  // The send machine's words as the mail ground hands them (share write-1: today's `app/shell/mail-send-text.ts` leaves).
  const { useMailSendText } = await import("./_write-1-send-text.js");
  const settled: string[] = [];
  const outcomes: string[] = [];
  let api!: { press: (kind: "reply" | "forward" | "compose", b: string) => Promise<void>; dock: (l: string) => string; withdraw: (l: string) => Promise<string> };
  const Probe = (): null => {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => engine.subscribe(() => force()), []);
    const mail = useMailSend(engine as never, null, (() => {}) as never,
      useMailSendText(), ((key: string) => { settled.push(key); }) as never,
      ((key: string, _m: unknown, accepted: boolean, phase?: string) => { outcomes.push(`${key}:${accepted ? "sent" : phase}`); return false; }) as never);
    const send = mail.send as unknown as (m: unknown, o?: unknown) => void;
    api = {
      press: async (kind, b) => { await act(async () => {
        if (kind === "reply") send(replyTo(b));
        else if (kind === "forward") send(forwardOf(b), { surface: "inline" });
        else send({ kind: "mail_send", inReplyTo: null, body: b, subject: "Hello", to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1" });
      }); },
      dock: (lane) => replyDockState(engine as never, mail.stateOf(lane), lane).phase,
      withdraw: async (lane) => { let r = ""; await act(async () => { r = await (mail as unknown as { withdraw: (l: string) => Promise<string> }).withdraw(lane); }); return r; },
    };
    return null;
  };
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Probe) })); });
  return { api: () => api, settled, outcomes, unmount: async () => { await act(async () => root.unmount()); roots = roots.filter((r) => r !== root); } };
}

type Window = { store: IndexedDbMirrorStore; engine: OhmailEngine; surface: Surface; tab: { dead: boolean } };
async function openWindow(w: Awaited<ReturnType<typeof world>>): Promise<Window> {
  const { IndexedDbMirrorStore } = await import("@ohmail/client-engine");
  const store = new IndexedDbMirrorStore({ owner: "o" }); await store.load();
  const tab = { dead: false };
  const engine = w.engine(store, tab);
  const s = await surface(engine);
  await act(async () => { await engine.start().catch(() => undefined); });
  await settle(10);
  return { store, engine, surface: s, tab };
}
async function closeWindow(win: Window, reg: ReturnType<typeof lockRegistry> | null): Promise<void> {
  await win.surface.unmount(); win.tab.dead = true; win.store.close(); reg?.close(win.engine);
}
const rowsOf = (win: Window) => win.store.entries<{ key: string; owner?: string; withdrawn?: boolean }>(OUTBOX_TYPE).map((e) => e.entity);
async function jarLanes(): Promise<string[]> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  return (JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Array<{ lane: string }>).map((r) => r.lane);
}
const scratch = async (lane: string): Promise<string> => (await import("@ohmail/app-logic/writing/mail-send")).readReplyDraft(lane, null).text;
async function writeScratch(lane: string, text: string): Promise<void> {
  (await import("@ohmail/app-logic/writing/mail-send")).writeReplyDraft(lane, { text, html: "" } as never, null);
}
async function online(w: Awaited<ReturnType<typeof world>>, wins: Window[]): Promise<void> {
  w.net.offline = false;
  for (let i = 0; i < 3; i++) {
    for (const win of wins) if (!win.tab.dead) await act(async () => { await win.engine.syncOnce().catch(() => undefined); });
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle(15);
  }
  await settle(30);
}

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(async () => { for (const r of roots) await act(async () => r.unmount()); roots = []; document.body.innerHTML = ""; vi.restoreAllMocks(); });

for (const kind of ["reply", "forward"] as const) {
  const lane = kind === "reply" ? "m-1" : "fwd:m-1";
  for (const order of ["B opens before A presses", "B opens after A presses"] as const) {
    it(`${kind}, ${order}: A sends it, B reads it waiting, one delivery, both docks end`, async () => {
      await idb();
      const reg = lockRegistry(); const w = await world(reg.api);
      const A = await openWindow(w);
      let B: Window | null = order === "B opens before A presses" ? await openWindow(w) : null;
      w.net.offline = true;
      await writeScratch(lane, WORDS);
      await A.surface.api().press(kind, WORDS); await settle(20);
      const row = rowsOf(A).find((r) => r.owner !== undefined);
      expect(row?.owner, "the row names A's lock").toBe(ownerOf(A.engine));
      B ??= await openWindow(w);
      await settle(10);
      const seen = {
        aDock: A.surface.api().dock(lane), bDock: B.surface.api().dock(lane),
        bQueued: B.engine.pendingMutations().some((p) => p.key === row!.key),
        bRow: rowsOf(B).some((r) => r.key === row!.key),
      };
      expect(seen, "B reads A's waiting send and does not queue it").toEqual({ aDock: "queued", bDock: "queued", bQueued: false, bRow: true });
      await online(w, [A, B]);
      expect({
        deliveries: w.fake.deliveries().length, keys: w.keys(), aDock: A.surface.api().dock(lane), bDock: B.surface.api().dock(lane),
        bEnded: B.surface.settled.includes(lane), scratch: await scratch(lane),
      }, "one delivery, and the ending reaches B's dock without a reload").toEqual({
        deliveries: 1, keys: 1, aDock: "idle", bDock: "idle", bEnded: true, scratch: "",
      });
    }, 60_000);
  }

  for (const [arm, bOpens] of [["withdrawn", "before"], ["on_the_wire", "before"], ["silent", "before"], ["withdrawn", "after"], ["silent", "after"]] as const) {
    it(`${kind}: Cancel in B (opened ${bOpens} A's press), the owning window ${arm === "silent" ? "silent" : `answers ${arm}`}`, async () => {
      await idb();
      const reg = lockRegistry(); const w = await world(reg.api);
      const A = await openWindow(w);
      let B: Window | null = bOpens === "before" ? await openWindow(w) : null;
      w.net.offline = true;
      await A.surface.api().press(kind, WORDS); await settle(20);
      const row = rowsOf(A).find((r) => r.owner !== undefined)!;
      expect(row.owner, "the row names A's lock").toBe(ownerOf(A.engine));
      // The cap's route (VERIFY-026-SEND-RECORD-2): B opened after the press reads the row at its boot.
      B ??= await openWindow(w);
      let release: (() => void) | null = null;
      if (arm === "on_the_wire") {
        // A's own hook takes it to the wire on the `online` event, and the answer waits at the gate.
        w.net.offline = false;
        release = w.fake.holdNext("POST", "/drafts/");
        await act(async () => { window.dispatchEvent(new Event("online")); });
        for (let i = 0; i < 100 && !A.engine.inFlightMutations().some((p) => p.key === row.key); i++) await settle(1);
        expect(A.engine.inFlightMutations().some((p) => p.key === row.key), "A's request is out").toBe(true);
      }
      if (arm === "silent") {
        (A.engine as unknown as { notices: unknown }).notices = null;
        (A.store as unknown as { bus: { close: () => void } }).bus.close();
      }
      const bBefore = B.surface.api().dock(lane);
      // The notice carries the SERVER's answer, so the answering arm cancels with the network back.
      if (arm === "withdrawn") w.net.offline = false;
      const said = await B.surface.api().withdraw(lane);
      await settle(10);
      const mid = { bBefore, said, bDock: B.surface.api().dock(lane), aDock: A.surface.api().dock(lane) };
      release?.();
      await online(w, [A, B]);
      const end = { deliveries: w.fake.deliveries().length, aDock: A.surface.api().dock(lane), bDock: B.surface.api().dock(lane), records: (await jarLanes()).filter((l) => l === lane).length };
      if (arm === "withdrawn") {
        expect({ mid, end, aHeard: A.surface.outcomes.includes(`${lane}:idle`) }).toEqual({
          mid: { bBefore: "queued", said: "close", bDock: "idle", aDock: "idle" },
          end: { deliveries: 0, aDock: "idle", bDock: "idle", records: 0 }, aHeard: true,
        });
      } else if (arm === "on_the_wire") {
        expect({ mid, end }).toEqual({
          mid: { bBefore: "queued", said: "already_sent", bDock: "queued", aDock: "queued" },
          end: { deliveries: 1, aDock: "idle", bDock: "idle", records: end.records },
        });
      } else {
        expect({ mid: { bBefore: mid.bBefore, said: mid.said, bDock: mid.bDock }, end: { deliveries: end.deliveries, aDock: end.aDock, bDock: end.bDock } }).toEqual({
          mid: { bBefore: "queued", said: "close", bDock: "idle" },
          end: { deliveries: 0, aDock: "idle", bDock: "idle" },
        });
      }
    }, 60_000);
  }
}

it("a send A's server refused is not B's delivery: B's dock is not settled and the words stay", async () => {
  await idb();
  const reg = lockRegistry(); const w = await world(reg.api);
  const A = await openWindow(w);
  const B = await openWindow(w);
  w.net.offline = true;
  await writeScratch("m-1", WORDS);
  await A.surface.api().press("reply", WORDS); await settle(20);
  expect(rowsOf(A).find((r) => r.owner !== undefined)?.owner).toBe(ownerOf(A.engine));
  await settle(10);
  expect(B.surface.api().dock("m-1")).toBe("queued");
  w.fake.answerNext("POST", "/drafts/", 422, { error: { code: "invalid_recipient", message: "That address can't receive mail." } });
  await online(w, [A, B]);
  expect({ deliveries: w.fake.deliveries().length, bSettled: B.surface.settled.includes("m-1"), aDock: A.surface.api().dock("m-1"), words: await scratch("m-1") })
    .toEqual({ deliveries: 0, bSettled: false, aDock: "failed", words: WORDS });
}, 60_000);

it("HAND BACK 2 B's mark the disk does not take: unknown, the dock held with its words and its record; again: withdrawn, 0 deliveries", async () => {
  await idb();
  const reg = lockRegistry(); const w = await world(reg.api);
  const A = await openWindow(w);
  const B = await openWindow(w);
  w.net.offline = true;
  await writeScratch("m-1", WORDS);
  await A.surface.api().press("reply", WORDS); await settle(20);
  expect(rowsOf(A).find((r) => r.owner !== undefined)?.owner).toBe(ownerOf(A.engine));
  await settle(10);
  const st = B.store as unknown as { decideOutboxRow: (...a: unknown[]) => Promise<unknown> };
  const real = st.decideOutboxRow.bind(B.store);
  st.decideOutboxRow = async () => { throw new Error("QuotaExceededError"); };
  const first = await B.surface.api().withdraw("m-1");
  await settle(5);
  const held = { dock: B.surface.api().dock("m-1"), words: await scratch("m-1"), records: (await jarLanes()).filter((l) => l === "m-1").length };
  st.decideOutboxRow = real;
  const second = await B.surface.api().withdraw("m-1");
  await online(w, [A, B]);
  expect({ first, held, second, deliveries: w.fake.deliveries().length })
    .toEqual({ first: "unknown", held: { dock: "queued", words: WORDS, records: 1 }, second: "close", deliveries: 0 });
}, 60_000);

it("LOW 1 a row that leaves with no ending heard is not a delivery: B keeps the reply box's words", async () => {
  await idb();
  const reg = lockRegistry(); const w = await world(reg.api);
  const A = await openWindow(w);
  const B = await openWindow(w);
  w.net.offline = true;
  await writeScratch("m-1", WORDS);
  await A.surface.api().press("reply", WORDS); await settle(20);
  expect(rowsOf(A).find((r) => r.owner !== undefined)?.owner).toBe(ownerOf(A.engine));
  await settle(10);
  expect(B.surface.api().dock("m-1")).toBe("queued");
  // A's ending never reaches B (said into nothing); its row still leaves the disk, refused.
  (A.engine as unknown as { notices: unknown }).notices = null;
  w.fake.answerNext("POST", "/drafts/", 422, { error: { code: "invalid_recipient", message: "That address can't receive mail." } });
  await online(w, [A, B]);
  expect({ rowGone: !rowsOf(B).some((r) => r.owner !== undefined), bSettled: B.surface.settled.includes("m-1"), words: await scratch("m-1") })
    .toEqual({ rowGone: true, bSettled: false, words: WORDS });
}, 60_000);

it("compose: B is held for A's waiting message only when B holds that message", async () => {
  await idb();
  const { writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
  const { sendUnsettledFromLastSession, standingOf } = await import("@ohmail/app-logic/writing/mail-send");
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  const reg = lockRegistry(); const w = await world(reg.api);
  const B = await openWindow(w);
  const A = await openWindow(w);
  w.net.offline = true;
  writeComposeDraft({ to: "bo@fake.test", cc: "", bcc: "", subject: "Hello", body: WORDS, html: "", fromMailboxId: "mb-1", sig: null } as never, null);
  await A.surface.api().press("compose", WORDS); await settle(20);
  expect(rowsOf(A).find((r) => r.owner !== undefined)?.owner).toBe(ownerOf(A.engine));
  await settle(10);
  const rec = (JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Array<{ lane: string; bfp?: string; session?: string }>).find((r) => r.lane === "compose")!;
  expect(rec.bfp, "the record names the buffer it was pressed from").toBeDefined();
  const held = (fp: string): boolean => sendUnsettledFromLastSession("compose", { fp, session: rec.session ?? null }, new Set(), false, null, standingOf(B.engine));
  expect({ that: held(rec.bfp!), another: held("another-message") }).toEqual({ that: true, another: false });
  await online(w, [A, B]);
  expect({ deliveries: w.fake.deliveries().length, that: held(rec.bfp!) }).toEqual({ deliveries: 1, that: false });
}, 60_000);

it("three windows: the reply is queued in its owner only, read waiting in both others, one delivery", async () => {
  await idb();
  const reg = lockRegistry(); const w = await world(reg.api);
  const B = await openWindow(w);
  const A = await openWindow(w);
  w.net.offline = true;
  await A.surface.api().press("reply", WORDS); await settle(20);
  const row = rowsOf(A).find((r) => r.owner !== undefined)!;
  expect(row.owner).toBe(ownerOf(A.engine));
  const C = await openWindow(w);
  await settle(10);
  expect([B, C].map((x) => ({ dock: x.surface.api().dock("m-1"), queued: x.engine.pendingMutations().some((p) => p.key === row.key) })))
    .toEqual([{ dock: "queued", queued: false }, { dock: "queued", queued: false }]);
  await online(w, [A, B, C]);
  expect({ deliveries: w.fake.deliveries().length, docks: [A, B, C].map((x) => x.surface.api().dock("m-1")) })
    .toEqual({ deliveries: 1, docks: ["idle", "idle", "idle"] });
}, 60_000);

it("the owning window reloads mid-send: one of the reloaded owner and B adopts, the reload is held, then cleared, one delivery", async () => {
  await idb();
  const reg = lockRegistry(); const w = await world(reg.api);
  const B = await openWindow(w);
  const A = await openWindow(w);
  w.net.offline = true;
  await A.surface.api().press("reply", WORDS); await settle(20);
  const row = rowsOf(A).find((r) => r.owner !== undefined)!;
  expect(row.owner).toBe(ownerOf(A.engine));
  await closeWindow(A, reg);
  const reopenedA = await openWindow(w);
  await act(async () => { await Promise.all([reopenedA.engine.syncOnce().catch(() => undefined), B.engine.syncOnce().catch(() => undefined)]); });
  await settle(10);
  const owner = rowsOf(B).find((r) => r.key === row.key)?.owner;
  const holders = [reopenedA, B].filter((x) => x.engine.pendingMutations().some((p) => p.key === row.key));
  expect({ adopted: [ownerOf(reopenedA.engine), ownerOf(B.engine)].includes(owner ?? null), holders: holders.length, a2Dock: reopenedA.surface.api().dock("m-1") })
    .toEqual({ adopted: true, holders: 1, a2Dock: "queued" });
  await online(w, [reopenedA, B]);
  expect({ deliveries: w.fake.deliveries().length, a2Dock: reopenedA.surface.api().dock("m-1"), bDock: B.surface.api().dock("m-1") })
    .toEqual({ deliveries: 1, a2Dock: "idle", bDock: "idle" });
}, 60_000);

it("the owning window closes with the reply queued: B adopts it, delivers it once, and its dock ends", async () => {
  await idb();
  const reg = lockRegistry(); const w = await world(reg.api);
  const B = await openWindow(w);
  const A = await openWindow(w);
  w.net.offline = true;
  await A.surface.api().press("reply", WORDS); await settle(20);
  expect(rowsOf(A).find((r) => r.owner !== undefined)?.owner).toBe(ownerOf(A.engine));
  await closeWindow(A, reg);
  await online(w, [B]);
  expect({ deliveries: w.fake.deliveries().length, keys: w.keys(), bDock: B.surface.api().dock("m-1") }).toEqual({ deliveries: 1, keys: 1, bDock: "idle" });
}, 60_000);

it("the owning window closes with its request in flight: B's replay is answered from the reservation, one delivery", async () => {
  await idb();
  const reg = lockRegistry(); const w = await world(reg.api);
  const B = await openWindow(w);
  const A = await openWindow(w);
  w.net.offline = true;
  await A.surface.api().press("reply", WORDS); await settle(20);
  const row = rowsOf(A).find((r) => r.owner !== undefined)!;
  expect(row.owner).toBe(ownerOf(A.engine));
  w.net.offline = false;
  w.fake.hangNext("POST", "/drafts/");
  void A.engine.retryQueued(A.engine.pendingMutations().find((p) => p.key === row.key)!.id);
  for (let i = 0; i < 100 && !w.fake.seen.some((r) => r.url.endsWith("/send")); i++) await settle(1);
  await closeWindow(A, reg);
  await online(w, [B]);
  expect({ deliveries: w.fake.deliveries().length, keys: w.keys(), bDock: B.surface.api().dock("m-1") }).toEqual({ deliveries: 1, keys: 1, bDock: "idle" });
}, 60_000);

it("locks: null (a browser without Web Locks): B opened after the press restores A's row and both send it under one key", async () => {
  await idb();
  const w = await world(null);
  const A = await openWindow(w);
  w.net.offline = true;
  await A.surface.api().press("reply", WORDS); await settle(20);
  expect(rowsOf(A).map((r) => r.owner ?? null), "no lock, no owner").toEqual([null]);
  const B = await openWindow(w);
  expect(B.engine.pendingMutations().length, "every window replays every row, as before").toBe(1);
  await online(w, [A, B]);
  expect({ deliveries: w.fake.deliveries().length, keys: w.keys() }).toEqual({ deliveries: 1, keys: 1 });
}, 60_000);
