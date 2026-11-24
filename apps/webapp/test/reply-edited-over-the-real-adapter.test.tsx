/** @vitest-environment jsdom */
/**
 * THE REPLY LANE'S EDITED RE-PRESS over the real HttpAdapter (L1): which words
 * went is the adapter's own reading of the kept-back save, never the double's. Its own file: it shares
 * the harness of send-past-a-day-goes-once and none of that file's earlier engines.
 */
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
  return { fake, store, net, engine, closeTabs };
}

/** One surface: compose (`inReplyTo: null`) or the inline reply to m-1. */
async function mount(e: OhmailEngine, said: string[]) {
  const { useMailSend, COMPOSE_SEND_KEY } = await import("@ohmail/app-logic/writing/mail-send");
  const { useMailSendText } = await import("./_write-1-send-text.js");
  let api!: { compose: (body: string) => Promise<void>; reply: (body: string) => Promise<void>; phase: (lane: string) => string; code: (lane: string) => string | null; lane: string };
  const Probe = (): null => {
    const mail = useMailSend(e as never, null, ((t: string) => { said.push(t); }) as never, useMailSendText(), (() => {}) as never, (() => false) as never);
    const press = (m: Record<string, unknown>, o?: unknown) => act(async () => { (mail.send as unknown as (m: unknown, o?: unknown) => void)(m, o); });
    api = {
      lane: COMPOSE_SEND_KEY,
      compose: (body) => press({ kind: "mail_send", inReplyTo: null, body, subject: "Hello", to: [{ name: null, address: "bo@fake.test" }], mailboxId: "mb-1" }),
      reply: (body) => press({ kind: "mail_send", inReplyTo: "m-1", body, subject: "Re: Invoice", to: [{ name: null, address: "ada@fake.test" }], mailboxId: "mb-1" }, { surface: "inline" }),
      phase: (lane) => mail.stateOf(lane).phase,
      code: (lane) => (mail.stateOf(lane) as { code?: string }).code ?? null,
    };
    return null;
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(Probe) })); });
  return api;
}

beforeEach(() => { window.localStorage.clear(); });
afterEach(async () => { await reload(); });

describe("the reply lane over the real adapter", () => {
  it("edited words pressed while the replay is on the wire: one delivery, said as the earlier version", async () => {
    const w = await world();
    const said: string[] = [];
    const e1 = w.engine();
    const s1 = await mount(e1, said);
    await act(async () => { await e1.start(); });
    w.net.offline = true;
    await s1.reply("Reply to Ada.");
    await settle(20);
    await reload();
    w.closeTabs();
    w.net.offline = false;
    w.net.later = 60 * 60 * 1000;
    const release = w.fake.holdNext("POST", "/drafts/");
    const e2 = w.engine();
    const s2 = await mount(e2, said);
    await act(async () => { void e2.start(); });
    for (let i = 0; i < 200 && !w.fake.seen.some((r) => /\/send$/.test(r.url)); i++) await settle(1);
    const atPress = JSON.stringify({ q: e2.pendingMutations().length, wire: e2.inFlightMutations().map((p) => (p as { createdRow?: { id: string } }).createdRow?.id ?? null), disk: (e2.read().list("outbox_entry") as Array<{ createdRow?: { id: string } }>).map((r) => r.createdRow?.id ?? null) });
    await s2.reply("Reply to Ada, with the figures.");
    release();
    // Until the newer press has spoken (the event, not a clock), bounded.
    for (let i = 0; i < 500 && said.length === 0; i++) await settle(1);
    expect({ delivered: w.fake.deliveries().length, said: said.at(-1) },
      `at press ${atPress}, wire ${w.fake.seen.filter((r) => r.method !== "GET").map((r) => r.method + " " + r.url).join(", ")}`)
      .toEqual({ delivered: 1, said: messages.reply.toastEarlierWent });
  }, 30_000);
});
