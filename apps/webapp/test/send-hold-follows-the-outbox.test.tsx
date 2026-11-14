/** @vitest-environment jsdom */
/**
 * THE COMPOSER'S HOLD FOLLOWS THE OUTBOX (VERIFY-026-ONE-KEY-2 HIGH, H1). A
 * composer restored after a reload is held only while its send is pending: queued, on the wire, on
 * the durable outbox, or not yet read from disk. A send that waited a day or a week replays and
 * goes once, and its composer is then free; a new compose with the same words is never held.
 * Over the real HttpAdapter and the fake send route with one reservation per key.
 */
/* @reads: apps/webapp/app */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { dto, listen, mailServer } from "../../mobile/test/helpers/mail-server";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
let root: Root | null = null;

const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};
async function reload(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
}

async function world() {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice", from: { name: "Ada", address: "ada@fake.test" } }));
  const store = new MemoryMirrorStore();
  await store.load();
  const net = { offline: false, later: 0 };
  /* The tab before a reload dies with it: its engine's requests stop, as a closed tab's do. */
  const tabs: Array<{ dead: boolean }> = [];
  const engine = () => {
    for (const t of tabs) t.dead = true;
    const me = { dead: false };
    tabs.push(me);
    return new OhmailEngine({
      store, now: () => new Date(Date.now() + net.later),
      adapter: new HttpAdapter({
        baseUrl: origin,
        fetch: (u: string, i?: RequestInit) => (me.dead || (net.offline && !String(u).includes("/sync"))
          ? Promise.reject(new TypeError("fetch failed")) : fetch(u, i)),
      } as never),
    });
  };
  const closeTabs = (): void => { for (const t of tabs) t.dead = true; };
  const keys = (): number => new Set(fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/send")).map((r) => r.key)).size;
  return { fake, store, net, engine, closeTabs, keys };
}

/** One surface: compose (`inReplyTo: null`) or the inline reply to m-1. */
async function mount(e: OhmailEngine, said: string[]) {
  const { useMailSend, COMPOSE_SEND_KEY } = await import("../app/shell/mail-send.js");
  let api!: {
    held: () => boolean; withdraw: () => Promise<string>;
    compose: (body: string) => Promise<void>; reply: (body: string) => Promise<void>;
  };
  const Probe = (): null => {
    const mail = useMailSend(e as never, ((t: string) => { said.push(t); }) as never, (() => {}) as never, (() => false) as never);
    const press = (m: Record<string, unknown>, o?: unknown) => act(async () => { (mail.send as unknown as (m: unknown, o?: unknown) => void)(m, o); });
    api = {
      held: () => mail.restoredPending(COMPOSE_SEND_KEY),
      withdraw: () => mail.withdraw(COMPOSE_SEND_KEY),
      compose: (body) => press({ kind: "mail_send", inReplyTo: null, body, subject: "Hello", to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1" }),
      reply: (body) => press({ kind: "mail_send", inReplyTo: "m-1", body, subject: "Re: Invoice", to: [{ name: null, address: "ada@fake.test" }], mailboxId: "mb-1" }, { surface: "inline" }),
    };
    return null;
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Probe) })); });
  return api;
}

async function jar(): Promise<Array<{ lane: string; key: string; at: number }>> {
  const { sendLocksKey } = await import("../app/shell/send-lock.js");
  return JSON.parse(window.localStorage.getItem(sendLocksKey()) ?? "[]") as Array<{ lane: string; key: string; at: number }>;
}
async function ageJar(ms: number): Promise<void> {
  const { sendLocksKey } = await import("../app/shell/send-lock.js");
  window.localStorage.setItem(sendLocksKey(), JSON.stringify((await jar()).map((r) => ({ ...r, at: r.at - ms }))));
}
async function buffer(body: string): Promise<void> {
  const { writeComposeDraft, EMPTY_COMPOSE } = await import("../app/shell/compose.js");
  writeComposeDraft({ ...EMPTY_COMPOSE, to: "bo@fake.test", subject: "Hello", body });
}

/** A new message pressed offline and the tab closed: the reload `later` on is the caller's. */
async function pressedOffline() {
  const w = await world();
  const said: string[] = [];
  const e1 = w.engine();
  const s1 = await mount(e1, said);
  await act(async () => { await e1.start(); });
  w.net.offline = true;
  await buffer("Hello Bo.");
  await s1.compose("Hello Bo.");
  await settle(20);
  await reload(); w.closeTabs();
  return { w, said };
}

async function boot(w: Awaited<ReturnType<typeof world>>, said: string[]) {
  await reload(); w.closeTabs();
  const e = w.engine();
  const s = await mount(e, said);
  /* Read before the outbox is restored: nothing can say then that the send is not pending. */
  const heldBeforeRestore = s.held();
  await act(async () => { await e.start(); });
  await settle();
  return { e, s, heldBeforeRestore };
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(async () => { await reload(); });

describe("the composer's hold follows the outbox", () => {
  for (const [label, later] of [["a day", DAY + HOUR], ["eight days", 8 * DAY]] as const) {
    it(`a send that waited ${label} holds its composer until the replay sends it once, then frees it`, async () => {
      const { w, said } = await pressedOffline();
      w.net.offline = false; w.net.later = later;
      await ageJar(later);
      const { e, s, heldBeforeRestore } = await boot(w, said);
      expect(heldBeforeRestore, "a send not yet read from disk left its composer free").toBe(true);
      expect({ delivered: w.fake.deliveries().length, kept: e.abandoned().length }, "the replay held the send back").toEqual({ delivered: 1, kept: 0 });
      expect(s.held(), "a sent message is held as still being sent").toBe(false);
      const { s: s2 } = await boot(w, said);
      expect(s2.held(), "after a reload a sent message is held as still being sent").toBe(false);
    }, 30_000);
  }

  it("a send still waiting after a day keeps its composer held, so an edited Send cannot go beside it", async () => {
    const { w, said } = await pressedOffline();
    w.net.later = DAY + HOUR;
    await ageJar(DAY + HOUR);
    const { e, s } = await boot(w, said);
    expect(s.held(), "the composer of a send still on the outbox is free").toBe(true);
    await s.compose("Hello Bo., edited on Friday.");
    await settle(10);
    w.net.offline = false;
    await act(async () => { await e.flushPending(); });
    await settle(20);
    expect([w.fake.deliveries().length, w.keys()], "the edited press went beside the waiting send").toEqual([1, 1]);
    expect(s.held(), "the sent message still holds its composer").toBe(false);
  }, 30_000);

  for (const words of ["Hello Bo.", "Something else entirely."]) {
    it(`a new compose writing ${words === "Hello Bo." ? "the SAME words" : "different words (control)"} after the send went is not held`, async () => {
      const { w, said } = await pressedOffline();
      w.net.offline = false;
      await boot(w, said);
      expect(w.fake.deliveries()).toHaveLength(1);
      const { clearComposeDraft } = await import("../app/shell/compose.js");
      clearComposeDraft();
      await buffer(words);
      const { s } = await boot(w, said);
      expect(s.held(), "a new message is held by another message's record").toBe(false);
    }, 30_000);
  }

  it("control: held while the send waits for the network after a reload", async () => {
    const { w, said } = await pressedOffline();
    const { e, s } = await boot(w, said);
    expect(e.abandoned(), "the waiting send was given up").toEqual([]);
    expect(s.held(), "not held while the send waits for the network").toBe(true);
    w.net.offline = false;
    await settle(5);
  }, 30_000);

  it("control: a reload whose outbox is not yet read from disk holds the composer until it is", async () => {
    const { existsSync } = await import("node:fs");
    const { createRequire } = await import("node:module");
    const { resolve } = await import("node:path");
    const pkg = existsSync(resolve("packages/client-engine/package.json"))
      ? resolve("packages/client-engine/package.json") : resolve("../../packages/client-engine/package.json");
    const { IDBFactory } = createRequire(pkg)("fake-indexeddb") as { IDBFactory: new () => IDBFactory };
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    const { IndexedDbMirrorStore } = await import("@ohmail/client-engine");
    const fake = mailServer();
    const origin = await listen(fake.server);
    let offline = true;
    const engineOver = (store: InstanceType<typeof IndexedDbMirrorStore>) => new OhmailEngine({
      store,
      adapter: new HttpAdapter({
        baseUrl: origin,
        fetch: (u: string, i?: RequestInit) => (offline && !String(u).includes("/sync")
          ? Promise.reject(new TypeError("fetch failed")) : fetch(u, i)),
      } as never),
    });
    const said: string[] = [];
    const first = new IndexedDbMirrorStore({ owner: "kept-send-owner" });
    await first.load();
    const e1 = engineOver(first);
    const s1 = await mount(e1, said);
    await act(async () => { await e1.start(); });
    await buffer("Hello Bo.");
    await s1.compose("Hello Bo.");
    await settle(20);
    await reload();
    first.close();
    const e2 = engineOver(new IndexedDbMirrorStore({ owner: "kept-send-owner" }));
    const s2 = await mount(e2, said);
    expect(s2.held(), "a send this tab cannot yet see on disk left its composer free").toBe(true);
    await act(async () => { await e2.start(); });
    await settle();
    expect(s2.held(), "the restored send, still waiting, left its composer free").toBe(true);
    offline = false;
    await settle(5);
  }, 30_000);

  for (const known of [false, true]) it(`before the outbox is read the hold's read deletes nothing on any lane (outbox ${known ? "known: both swept, the control" : "unread"})`, async () => {
    const { claimSendLock, sendLocksKey, SEND_LOCK_FORMAT } = await import("../app/shell/send-lock.js");
    const { sendUnsettledFromLastSession } = await import("../app/shell/mail-send.js");
    for (const [lane, key] of [["compose", "k-compose"], ["m-1", "k-reply"]] as const) {
      claimSendLock({ v: SEND_LOCK_FORMAT, lane, key, at: Date.now(), draftId: null, fp: `fp-${lane}`, session: "s-1", ...(lane === "compose" ? { bfp: "bfp-1" } : {}) } as never, () => false, null);
    }
    const aged = (JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Array<{ at: number }>).map((r) => ({ ...r, at: r.at - 8 * DAY }));
    window.localStorage.setItem(sendLocksKey(null), JSON.stringify(aged));
    const held = sendUnsettledFromLastSession("compose", { fp: "bfp-1", session: "s-1" }, new Set(), false, null, { settled: () => known, owed: () => !known });
    const lanes = (JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Array<{ lane: string }>).map((r) => r.lane);
    expect({ held, lanes }).toEqual(known ? { held: false, lanes: [] } : { held: true, lanes: ["compose", "m-1"] });
  });

  it("every web discard of an unsaved change goes through the one door", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative } = await import("node:path");
    const { withoutComments } = await import("../../../scripts/lib/source-scan.mjs");
    const root = join(__dirname, "../app");
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n) && /\.discardAbandoned\(/.test(withoutComments(readFileSync(p, "utf8")))) callers.push(relative(root, p));
      }
    };
    walk(root);
    walk(join(__dirname, "../../../packages/app-logic/src"));
    expect(callers, "a discard that bypasses discardUnsavedChange").toEqual(["shell/mail-send.ts"]);
  });
});
