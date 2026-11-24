/** @vitest-environment jsdom */
/**
 * A SEND'S ENDING REACHES ITS COMPOSER AT ANY AGE (HIGH). The compose surface as
 * the shell wires it (`useMailSend`, `useComposeAutosave`, `settleCompose`) over the real HttpAdapter:
 * a new message sent offline and replayed 25 h, 6 d 23 h, 7 d 1 h or 8 d later is delivered once and
 * its composer is CLEARED, so an edited Send is a new message. Also the order the shell runs in (the
 * store unhydrated at mount), an aged refusal, a re-minted compose left alone, and an outbox read that
 * never settles.
 */
/* @reads: packages/app-logic/src/writing/mail-send.ts */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import type { MirrorStore } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { dto, listen, mailServer } from "../../mobile/test/helpers/mail-server";
import type { ComposeFields } from "@ohmail/app-logic/writing/compose";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const FIRST = "See you tomorrow, Bo.";
let root: Root | null = null;
const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
async function unmount(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null; document.body.innerHTML = "";
}
const EMPTY = ({ to: "", cc: "", bcc: "", subject: "", body: "", html: "", fromMailboxId: "mb-1", sig: null } as never) as ComposeFields;
const fieldsFor = (body: string): ComposeFields => ({ to: "bo@fake.test", cc: "", bcc: "", subject: "Hello", body, html: "", fromMailboxId: "mb-1", sig: null } as never);

async function world() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice", from: { name: "Ada", address: "ada@fake.test" } }));
  const memory = new MemoryMirrorStore(); await memory.load();
  const net = { offline: false };
  const tabs: Array<{ dead: boolean }> = [];
  const engine = (store: MirrorStore = memory) => {
    for (const t of tabs) t.dead = true;
    const me = { dead: false }; tabs.push(me);
    return new OhmailEngine({
      store,
      adapter: new HttpAdapter({ baseUrl: origin, fetch: (u: string, i?: RequestInit) => (me.dead || (net.offline && !String(u).includes("/sync")) ? Promise.reject(new TypeError("fetch failed")) : fetch(u, i)) } as never),
    });
  };
  const keys = (): number => new Set(fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/send")).map((r) => r.key)).size;
  const sentBodies = (): string[] => fake.draftRows().filter((d) => (d as { status?: string }).status === "sent").map((d) => String((d as { body?: string }).body));
  return { fake, net, engine, keys, sentBodies };
}

/** The compose surface as the shell wires it: useMailSend + useComposeAutosave + settleCompose. */
async function surface(engine: OhmailEngine) {
  const { useMailSend, SEND_IN_FLIGHT_PHASES, sendPendingInOutbox } = await import("@ohmail/app-logic/writing/mail-send");
  /* The send machine's words as the mail ground hands them (today's `app/shell/mail-send-text` leaves). */
  const { useMailSendText } = await import("./_write-1-send-text.js");
  const { useComposeAutosave } = await import("@ohmail/app-logic/writing/compose-autosave");
  const { readComposeDraft, writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
  const initial = readComposeDraft(null);
  let api!: { body: () => string; held: () => boolean; phase: () => string; write: (b: string) => Promise<void>; press: () => Promise<void> };
  const Probe = (): null => {
    const [fields, setF] = React.useState<ComposeFields>({ ...EMPTY, ...initial } as ComposeFields);
    const settleRef = React.useRef<(rowId: string | null, about: boolean) => void>(() => {});
    const mail = useMailSend(engine as never, null, (() => {}) as never,
      useMailSendText(), ((key: string, m: { draftId?: string | null }, about: boolean) => { if (key === "compose") settleRef.current(m.draftId ?? null, about); }) as never);
    const autosave = useComposeAutosave({
      engine: engine as never, fields, mailboxId: "mb-1", active: true,
      sendInFlight: SEND_IN_FLIGHT_PHASES.has(mail.stateOf("compose").phase) || sendPendingInOutbox(engine as never, "compose") || mail.restoredPending("compose"),
      onCleared: () => { setF(EMPTY); },
      scope: null,
    });
    settleRef.current = (rowId, about) => { autosave.settleCompose({ kind: "sentByMirror", rowId, aboutThisCompose: about }); };
    api = {
      body: () => fields.body,
      held: () => mail.restoredPending("compose"),
      phase: () => mail.stateOf("compose").phase,
      write: async (b) => { await act(async () => { setF(() => { const n = fieldsFor(b); writeComposeDraft(n, null); return n; }); }); },
      press: async () => {
        await act(async () => { (mail.send as unknown as (m: unknown) => void)({ kind: "mail_send", inReplyTo: null, body: fields.body, subject: "Hello", to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1", ...(autosave.draftId ? { draftId: autosave.draftId } : {}) }); });
      },
    };
    return null;
  };
  const host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Probe) })); });
  return { body: () => api.body(), held: () => api.held(), phase: () => api.phase(), write: (b: string) => api.write(b), press: () => api.press() };
}

async function sentOffline(w: Awaited<ReturnType<typeof world>>): Promise<void> {
  const { writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
  writeComposeDraft(fieldsFor(FIRST), null);
  const e1 = w.engine();
  const s1 = await surface(e1);
  await act(async () => { await e1.start(); });
  w.net.offline = true;
  await s1.press();
  await settle(20);
  expect(e1.pendingMutations(), "premise: the send waits on the outbox").toHaveLength(1);
  await unmount();
}
async function jar(): Promise<Array<{ at: number }>> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  return JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Array<{ at: number }>;
}
async function ageJar(ms: number): Promise<void> {
  const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
  window.localStorage.setItem(sendLocksKey(null), JSON.stringify((await jar()).map((r) => ({ ...r, at: r.at - ms }))));
}
const buffered = async (): Promise<string> => (await import("@ohmail/app-logic/writing/compose")).readComposeDraft(null).body;

beforeEach(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
afterEach(async () => { await unmount(); vi.restoreAllMocks(); });

describe("a send's ending reaches its composer at any age", () => {
  for (const [label, later] of [["25 h", DAY + HOUR], ["6 d 23 h", 7 * DAY - HOUR], ["7 d 1 h", 7 * DAY + HOUR], ["8 d", 8 * DAY]] as const) {
    it(`replayed ${label} later: delivered once, the composer CLEARED, and a new message is its own send`, async () => {
      const w = await world();
      await sentOffline(w);
      w.net.offline = false;
      await ageJar(later);
      const e2 = w.engine();
      const s2 = await surface(e2);
      await act(async () => { await e2.start(); });
      await settle(60);
      expect({ delivered: w.fake.deliveries().length, body: s2.body(), buffer: await buffered(), held: s2.held() },
        "the sent words stayed in the composer").toEqual({ delivered: 1, body: "", buffer: "", held: false });
      await s2.write("Friday works better, Bo.");
      await s2.press();
      await settle(40);
      expect({ delivered: w.fake.deliveries().length, keys: w.keys(), sent: w.sentBodies().sort() }, "the old words went again")
        .toEqual({ delivered: 2, keys: 2, sent: ["Friday works better, Bo.", FIRST] });
    }, 60_000);
  }

  it("the shell's order, the store unhydrated at mount, 8 d: held until the restore, delivered once, then cleared", async () => {
    const { existsSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const { resolve } = await import("node:path");
    const pkg = existsSync(resolve("packages/client-engine/package.json"))
      ? resolve("packages/client-engine/package.json") : resolve("../../packages/client-engine/package.json");
    const { IDBFactory } = createRequire(pkg)("fake-indexeddb") as { IDBFactory: new () => IDBFactory };
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const { IndexedDbMirrorStore } = await import("@ohmail/client-engine");
    const w = await world();
    const first = new IndexedDbMirrorStore({ owner: "ending-owner" });
    await first.load();
    const { writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    writeComposeDraft(fieldsFor(FIRST), null);
    const e1 = w.engine(first);
    const s1 = await surface(e1);
    await act(async () => { await e1.start(); });
    w.net.offline = true;
    await s1.press();
    await settle(20);
    await unmount();
    first.close();
    await ageJar(8 * DAY);
    w.net.offline = false;
    const e2 = w.engine(new IndexedDbMirrorStore({ owner: "ending-owner" }));
    const s2 = await surface(e2);
    expect({ held: s2.held(), records: (await jar()).length }, "the hold's read before the restore swept the record or freed the composer")
      .toEqual({ held: true, records: 1 });
    await act(async () => { await e2.start(); });
    await settle(60);
    expect({ delivered: w.fake.deliveries().length, body: s2.body(), buffer: await buffered(), held: s2.held(), records: (await jar()).length },
      "the replay's ending did not clear its composer").toEqual({ delivered: 1, body: "", buffer: "", held: false, records: 0 });
  }, 60_000);

  it("an aged REFUSED ending reaches its composer: the failure is said there", async () => {
    const w = await world();
    await sentOffline(w);
    w.net.offline = false;
    await ageJar(8 * DAY);
    w.fake.answerNext("POST", "/drafts/", 409, { status: "failed", message: "The mail server refused the message." });
    const e2 = w.engine();
    const s2 = await surface(e2);
    await act(async () => { await e2.start(); });
    await settle(60);
    expect({ delivered: w.fake.deliveries().length, phase: s2.phase(), records: (await jar()).length },
      "an eight-day refusal said nothing to its composer").toEqual({ delivered: 0, phase: "failed", records: 0 });
  }, 60_000);

  it("a re-minted compose is left alone at 8 d: the ending does not clear a different message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world();
    await sentOffline(w);
    const { clearComposeDraft, writeComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    clearComposeDraft(null);
    writeComposeDraft(fieldsFor("Wann kommt der Ofen?"), null);
    w.net.offline = false;
    await ageJar(8 * DAY);
    const e2 = w.engine();
    const s2 = await surface(e2);
    await act(async () => { await e2.start(); });
    await settle(60);
    expect({ delivered: w.fake.deliveries().length, body: s2.body(), buffer: await buffered() }, "the ending wiped a message nobody sent")
      .toEqual({ delivered: 1, body: "Wann kommt der Ofen?", buffer: "Wann kommt der Ofen?" });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("send_settled_unbound"))).toBe(true);
  }, 60_000);

  it("an outbox read that never settles holds that composer, and the person's Discard ends it; a new compose is not held", async () => {
    class RefusingStore extends MemoryMirrorStore {
      protected override async readPersisted(): Promise<void> { throw new Error("the disk read failed"); }
    }
    const w = await world();
    await sentOffline(w);
    await ageJar(8 * DAY);
    const e2 = w.engine(new RefusingStore());
    const s2 = await surface(e2);
    await act(async () => { await e2.start().catch(() => {}); });
    await settle(20);
    expect({ known: e2.outboxKnown(), held: s2.held() }, "a failed read settled the outbox, or freed the composer")
      .toEqual({ known: false, held: true });
    const { clearComposeDraft } = await import("@ohmail/app-logic/writing/compose");
    await unmount();
    clearComposeDraft(null);
    (await import("@ohmail/app-logic/writing/compose")).writeComposeDraft(fieldsFor("A different message."), null);
    const s3 = await surface(e2);
    expect(s3.held(), "a new compose after Discard is held by the old message").toBe(false);
  }, 60_000);
});
