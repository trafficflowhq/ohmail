/** @vitest-environment jsdom */
/**
 * TWO WINDOWS, ONE JAR (HIGH-1, re-driven by that change).
 * Each window is its own engine over its own IndexedDB store on one disk, each holding its own Web
 * Lock from ONE injected registry, and both share the send-lock jar. Window B opened BEFORE A's press
 * reads A's waiting send by the store's notice, and must not delete A's record whether it presses a
 * new message (any age), a reply, or only renders (eight days on). Age is the clock moving. The
 * `locks: null` twin is the shape without Web Locks, for the order it applies to (B opens after).
 */
/* @reads: packages/app-logic/src/writing/mail-send.ts */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, OhmailEngine, OUTBOX_TYPE } from "@ohmail/client-engine";
import type { EngineLocks, MirrorStore } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { dto, listen, mailServer } from "../../mobile/test/helpers/mail-server";
import type { ComposeFields } from "@ohmail/app-logic/writing/compose";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const DAY = 24 * 60 * 60 * 1000;
const FIRST = "See you tomorrow, Bo.";
let roots: Root[] = [];
const settle = async (n = 30): Promise<void> => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); }); };
async function unmountAll(): Promise<void> { for (const r of roots) await act(async () => r.unmount()); roots = []; document.body.innerHTML = ""; }
const EMPTY = ({ to: "", cc: "", bcc: "", subject: "", body: "", html: "", fromMailboxId: "mb-1", sig: null } as never) as ComposeFields;
const fieldsFor = (body: string): ComposeFields => ({ to: "bo@fake.test", cc: "", bcc: "", subject: "Hello", body, html: "", fromMailboxId: "mb-1", sig: null } as never);

async function idb(): Promise<void> {
  const { createRequire } = await import("node:module");
  const { resolve } = await import("node:path");
  const fake = createRequire(resolve("packages/client-engine/package.json"))("fake-indexeddb") as { IDBFactory: new () => IDBFactory; IDBKeyRange: unknown };
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new fake.IDBFactory();
  (globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = fake.IDBKeyRange;
}
/** One browser's Web Locks: every window's engine asks the same registry; a closed tab's lock goes. */
function lockRegistry(): { api: EngineLocks; close: (engine: OhmailEngine) => void } {
  const held = new Set<string>();
  return {
    api: { async request(name, _o, cb) { held.add(name); return cb({ name }); }, async query() { return { held: [...held].map((name) => ({ name })) }; } },
    close: (engine) => { held.delete((engine as unknown as { ownerName: string }).ownerName); },
  };
}
async function world(locks: EngineLocks | null) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice", from: { name: "Ada", address: "ada@fake.test" } }));
  const net = { offline: false };
  const engine = (store: MirrorStore, tab: { dead: boolean }) => new OhmailEngine({ store, locks,
    adapter: new HttpAdapter({ baseUrl: origin, fetch: (u: string, i?: RequestInit) => (tab.dead || (net.offline && !String(u).includes("/sync")) ? Promise.reject(new TypeError("fetch failed")) : fetch(u, i)) } as never) });
  const keys = (): number => new Set(fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/send")).map((r) => r.key)).size;
  const sentBodies = (): string[] => fake.draftRows().filter((d) => (d as { status?: string }).status === "sent").map((d) => String((d as { body?: string }).body));
  return { fake, net, engine, keys, sentBodies };
}
async function surface(engine: OhmailEngine) {
  const { useMailSend, SEND_IN_FLIGHT_PHASES, sendPendingInOutbox } = await import("@ohmail/app-logic/writing/mail-send");
  const { useMailSendText } = await import("./_write-1-send-text.js");
  const { useComposeAutosave } = await import("@ohmail/app-logic/writing/compose-autosave");
  const { readComposeDraft, writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
  const initial = readComposeDraft(null);
  let api!: { body: () => string; held: () => boolean; edit: (a: string, b: string) => Promise<void>; press: () => Promise<void> };
  const Probe = (): null => {
    const [fields, setF] = React.useState<ComposeFields>({ ...EMPTY, ...initial } as ComposeFields);
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    React.useEffect(() => engine.subscribe(() => force()), []);
    const settleRef = React.useRef<(rowId: string | null, about: boolean) => void>(() => {});
    const mail = useMailSend(engine as never, null, (() => {}) as never,
      useMailSendText(), ((key: string, m: { draftId?: string | null }, about: boolean) => { if (key === "compose") settleRef.current(m.draftId ?? null, about); }) as never);
    const autosave = useComposeAutosave({ engine: engine as never, fields, mailboxId: "mb-1", active: true,
      sendInFlight: SEND_IN_FLIGHT_PHASES.has(mail.stateOf("compose").phase) || sendPendingInOutbox(engine as never, "compose") || mail.restoredPending("compose"),
      onCleared: () => { setF(EMPTY); },
      scope: null, });
    settleRef.current = (rowId, about) => { autosave.settleCompose({ kind: "sentByMirror", rowId, aboutThisCompose: about }); };
    api = {
      body: () => fields.body, held: () => mail.restoredPending("compose"),
      edit: async (a, b) => { await act(async () => { setF((f) => { const n = { ...f, body: f.body.replace(a, b) }; writeComposeDraft(n, null); return n; }); }); },
      press: async () => { if (fields.body === "") return; await act(async () => { (mail.send as unknown as (m: unknown) => void)({ kind: "mail_send", inReplyTo: null, body: fields.body, subject: "Hello", to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1", ...(autosave.draftId ? { draftId: autosave.draftId } : {}) }); }); },
    };
    return null;
  };
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Probe) })); });
  return { body: () => api.body(), held: () => api.held(), edit: (a: string, b: string) => api.edit(a, b), press: () => api.press(),
    unmount: async () => { await act(async () => root.unmount()); roots = roots.filter((r) => r !== root); } };
}
async function jar(): Promise<Array<{ at: number; lane: string; key: string }>> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  return JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Array<{ at: number; lane: string; key: string }>;
}
async function ageJar(ms: number): Promise<void> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  window.localStorage.setItem(sendLocksKey(null), JSON.stringify((await jar()).map((r) => ({ ...r, at: r.at - ms }))));
}
const buffered = async (): Promise<string> => (await import("@ohmail/app-logic/writing/compose")).readComposeDraft(null).body;

let shift = 0;
beforeEach(() => {
  window.localStorage.clear(); window.sessionStorage.clear(); shift = 0;
  const real = Date.now.bind(Date);
  vi.spyOn(Date, "now").mockImplementation(() => real() + shift);
});
afterEach(async () => { await unmountAll(); vi.restoreAllMocks(); });

/* B's press as useMailSend.send runs it for a compose-lane message that joins nothing (resume, then claim), and B's reply press (resume, then claim, on lane m-1). */
async function bPress(eB: OhmailEngine, what: "compose" | "reply") {
  const { claimSendLock, resumeSendLock, sendIdentity, SEND_LOCK_FORMAT } = await import("@ohmail/app-logic/writing/send-lock");
  const { sendLockOwed } = await import("@ohmail/app-logic/writing/mail-send");
  const owed = sendLockOwed(eB);
  const m = what === "compose"
    ? { kind: "mail_send", inReplyTo: null, body: "Lunch on Monday, Cy?", subject: "Lunch", to: [{ name: null, address: "cy@fake.test" }], mailboxId: "mb-1" }
    : { kind: "mail_send", inReplyTo: "m-1", body: "Thanks, Ada.", subject: "Re: Invoice", to: [{ name: "Ada", address: "ada@fake.test" }], mailboxId: "mb-1" };
  const lane = what === "compose" ? "compose" : "m-1";
  const id = sendIdentity(m as never, what === "compose" ? "tab-b-session" : null);
  const resumed = resumeSendLock(lane, id, Date.now(), owed, null);
  if (resumed === null) claimSendLock({ v: SEND_LOCK_FORMAT, lane, key: crypto.randomUUID(), at: Date.now(), draftId: null, fp: id.fp,
    ...(id.subjects[0] !== undefined ? { subject: id.subjects[0] } : {}), ...(what === "compose" ? { session: "tab-b-session", bfp: "tab-b-buffer" } : {}) }, owed, null);
}

const CASES = [["locks", "before A presses"], ["locks", "after A presses"], ["no locks", "after A presses"]] as const;
for (const [mode, bOpens] of CASES) {
  for (const [what, age] of [["compose", 0], ["compose", 8 * DAY], ["reply", 8 * DAY], ["render", 8 * DAY]] as const) {
    it(`${mode}: B opens ${bOpens}; B ${what === "render" ? "renders" : `presses a ${what}`} ${age / DAY} d later: A's record kept, A held after a reload, one delivery, A's composer cleared`, async () => {
      await idb();
      const { IndexedDbMirrorStore } = await import("@ohmail/client-engine");
      const { standingOf, sendUnsettledFromLastSession } = await import("@ohmail/app-logic/writing/mail-send");
      const reg = mode === "locks" ? lockRegistry() : null;
      const w = await world(reg?.api ?? null);
      const { writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
      writeComposeDraft(fieldsFor(FIRST), null);
      const tabA = { dead: false }; const tabB = { dead: false };
      const storeA = new IndexedDbMirrorStore({ owner: "o" }); await storeA.load();
      const eA = w.engine(storeA, tabA);
      const sA = await surface(eA);
      await act(async () => { await eA.start(); });
      let storeB: InstanceType<typeof IndexedDbMirrorStore> | null = null; let eB: OhmailEngine | null = null;
      const openB = async () => { storeB = new IndexedDbMirrorStore({ owner: "o" }); await storeB.load(); eB = w.engine(storeB, tabB); await act(async () => { await eB!.start(); }); };
      if (bOpens === "before A presses") await openB();
      w.net.offline = true;
      await sA.press(); await settle(20);
      const keyA = (await jar()).find((r) => r.lane === "compose")?.key ?? "none";
      // THE OWNER FIRST: the row names A's lock, or no lock at all where there are none.
      const written = storeA.entries<{ key: string; owner?: string }>(OUTBOX_TYPE).map((e) => e.entity).find((r) => r.key === keyA);
      expect(written?.owner ?? null, "the row's owner").toBe(reg === null ? null : (eA as unknown as { ownerName: string }).ownerName);
      if (bOpens === "after A presses") await openB();
      shift += age;
      if (what === "render") sendUnsettledFromLastSession("compose", { fp: "x", session: null }, new Set(), false, null, standingOf(eB!));
      else await bPress(eB!, what);
      const aRecordKept = (await jar()).some((r) => r.key === keyA);
      // A's window reloads, still offline.
      await sA.unmount(); tabA.dead = true; storeA.close(); reg?.close(eA);
      const storeA2 = new IndexedDbMirrorStore({ owner: "o" }); await storeA2.load();
      const tabA2 = { dead: false };
      const eA2 = w.engine(storeA2, tabA2);
      const sA2 = await surface(eA2);
      await act(async () => { await eA2.start(); }); await settle(30);
      const heldAfterReload = sA2.held();
      await sA2.edit("tomorrow", "Friday"); await sA2.press(); await settle(20);
      w.net.offline = false;
      for (let i = 0; i < 3; i++) { await act(async () => { await eA2.syncOnce(); await eB!.syncOnce(); }); await settle(10); }
      await settle(40);
      const seen = { aRecordKept, heldAfterReload, deliveriesToBo: w.sentBodies().filter((b) => b.includes("Bo.")), body: sA2.body(), buffer: await buffered() };
      storeA2.close(); (storeB as unknown as { close: () => void } | null)?.close();
      expect(seen, "window B deleted window A's waiting record").toEqual({
        aRecordKept: true, heldAfterReload: true, deliveriesToBo: [FIRST], body: "", buffer: "",
      });
      expect(w.keys(), "keys on the wire: A's one (B's presses are modelled on the jar alone)").toBe(1);
    }, 60_000);
  }
}
