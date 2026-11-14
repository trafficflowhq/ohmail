/** @vitest-environment jsdom */
/**
 * A SEND THAT WAITED MORE THAN A DAY GOES ONCE, over the real HttpAdapter and a fake whose send
 * route keeps one reservation per key. A new message written and sent offline, the tab reopened a
 * day or eight days later: the replay sends it under its key, nothing is kept back, and Send pressed
 * again in the composer is a new key the server refuses as a second copy (a settled key is spent).
 * Also the confirmed send kept for its echo.
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
  fake.setContentClaim(true);
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
  /* The send machine's words as the mail ground hands them (today's `app/shell/mail-send-text` leaves). */
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

const keysOf = (w: Awaited<ReturnType<typeof world>>): number =>
  new Set(w.fake.seen.filter((r) => r.method === "POST" && r.url.endsWith("/send")).map((r) => r.key)).size;

describe("a new message that waited more than a day", () => {
  for (const [label, later] of [["a day", DAY + 60 * 60 * 1000], ["eight days, past the lock's own age", 8 * DAY]] as const) it(`${label} on: the replay sends it once and nothing is kept`, async () => {
    const w = await world();
    const said: string[] = [];
    const e1 = w.engine();
    const s1 = await mount(e1, said);
    await act(async () => { await e1.start(); });
    w.net.offline = true;
    await s1.compose("Hello Bo.");
    await settle(20);
    await reload();
    w.closeTabs();
    w.net.offline = false;
    w.net.later = later;
    // The lock reads the wall clock, the engine its own: the jar is aged by the same span.
    const { sendLocksKey } = await import("@ohmail/app-logic/writing/send-lock");
    const jar = JSON.parse(window.localStorage.getItem(sendLocksKey(null)) ?? "[]") as Array<{ at: number }>;
    expect(jar.length, "premise: the press wrote its lock").toBeGreaterThan(0);
    window.localStorage.setItem(sendLocksKey(null), JSON.stringify(jar.map((r) => ({ ...r, at: r.at - later }))));
    const e2 = w.engine();
    const s2 = await mount(e2, said);
    await act(async () => { await e2.start(); });
    await settle();
    expect({ delivered: w.fake.deliveries().length, kept: e2.abandoned().length },
      "a send that waited was kept instead of sent").toEqual({ delivered: 1, kept: 0 });
    // The same words pressed again after the replay settled: its key is spent, so this is a new
    // key, and the server's content claim refuses the second copy, naming the first send.
    if (later < 7 * DAY) {
      await s2.compose("Hello Bo.");
      await settle(40);
      expect({ delivered: w.fake.deliveries().length, keys: keysOf(w), refused: w.fake.duplicates().length },
        "Send again after the replay went twice").toEqual({ delivered: 1, keys: 2, refused: 1 });
    }
  }, 30_000);
});

describe("a new message this tab held queued for more than a day", () => {
  it("goes once when the network is back, and nothing is kept", async () => {
    const w = await world();
    const said: string[] = [];
    const e = w.engine();
    const s1 = await mount(e, said);
    await act(async () => { await e.start(); });
    w.net.offline = true;
    await s1.compose("Hello Bo.");
    await settle(20);
    w.net.offline = false;
    w.net.later = 8 * DAY;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await settle(30);
    expect({ delivered: w.fake.deliveries().length, keys: keysOf(w), kept: e.abandoned().length })
      .toEqual({ delivered: 1, keys: 1, kept: 0 });
  }, 30_000);
});

describe("a send confirmed and kept only for its echo", () => {
  it("is not the standing send a new reply joins", async () => {
    const { standingSendKey } = await import("@ohmail/app-logic/writing/mail-send");
    const store = new MemoryMirrorStore();
    await store.load();
    const at = new Date().toISOString();
    await store.applyChanges([{ type: "message", op: "create", id: "m-1", seq: 1, updatedAt: at, entity: {
      id: "m-1", accountId: "acct-1", mailboxId: "mb-1", threadId: null, messageIdHeader: "<m-1@fake.test>", subject: "Invoice",
      from: { name: "Ada", address: "ada@fake.test" }, to: [], cc: [], date: at, folder: "INBOX", snippet: "", unread: false,
      hasAttachments: false, attachmentCount: 0, triage: null, labels: [], remoteContent: "none", updatedAt: at,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    } }] as never);
    const apply = store.applyChanges.bind(store);
    let refuse = true;
    store.applyChanges = (async (...a: Parameters<typeof apply>) => {
      if (refuse && (a[0] as Array<{ type: string }>).some((c) => c.type === "draft")) { refuse = false; throw new Error("QuotaExceededError"); }
      return apply(...a);
    }) as typeof store.applyChanges;
    const e = new OhmailEngine({
      store, now: () => new Date(),
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }),
        fetchBody: async () => null,
        mutate: async (_m: unknown, o: { idempotencyKey: string }) => ({
          changes: [{ type: "draft", op: "update", id: `row-${o.idempotencyKey}`, seq: 2, updatedAt: new Date().toISOString(), entity: { id: `row-${o.idempotencyKey}`, status: "sent" } }],
          seq: 2, providerMessageId: "<x@y>",
        }),
      } as never,
    });
    await e.start();
    const r = await e.mutate({ kind: "mail_send", inReplyTo: "m-1", body: "First.", subject: "Re", to: [{ name: null, address: "ada@fake.test" }], mailboxId: "mb-1" } as never);
    expect(r.status).toBe("confirmed");
    const rows = e.read().list("outbox_entry") as Array<{ confirmed?: boolean }>;
    expect({ kept: rows.length, standing: standingSendKey(e as never, "m-1") }, "a new reply would be answered from a delivered key")
      .toEqual({ kept: 1, standing: null });
    // And after a restart, where the kept row is back on the queue for its replay.
    const again = new OhmailEngine({ store, now: () => new Date(), adapter: { sync: async () => { throw new Error("offline"); }, fetchBody: async () => null, mutate: async () => { throw new Error("offline"); } } as never, outboxAutoReplay: false } as never);
    again.restoreOutbox();
    expect({ queued: again.pendingMutations().length, standing: standingSendKey(again as never, "m-1") })
      .toEqual({ queued: 1, standing: null });
  });
});
