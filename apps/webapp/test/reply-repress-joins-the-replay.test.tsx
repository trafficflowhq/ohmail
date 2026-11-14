/** @vitest-environment jsdom */
/**
 * REPRESS-DURING-A-FLUSH-SENDS-TWICE on the web's reply lane: a reply queued,
 * the tab reloaded, and the reply pressed again while the boot replay still carries it. The
 * compose lane is held by `sendUnsettledFromLastSession`; the reply lane resumes its key only
 * through the lock record. Counted at the wire: distinct keys and deliveries.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { scheduleLabel } from "@ohmail/app-logic/text/format";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { useSendText } from "@ohmail/app-logic/writing/mail-send-text";
import { MutationRejectedError, OhmailEngine, MemoryMirrorStore } from "@ohmail/client-engine";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const NOW = new Date("2026-10-04T09:00:00.000Z");
const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
let root: Root | null = null;

interface Wire { attempts: Array<{ key: string; body: string }>; deliveries: Array<{ key: string; body: string }>; offline: boolean; slowMs: number; said: string[] }
const wire = (): Wire => ({ attempts: [], deliveries: [], offline: false, slowMs: 0, said: [] });

/** The send route's reservation: one per key, a reserved key is answered, never sent again. */
function engineOver(store: MemoryMirrorStore, w: Wire): OhmailEngine {
  const reserved = new Map<string, string>();
  return new OhmailEngine({
    store, now: () => new Date(Date.now()),
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation, opts: { idempotencyKey: string }) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        const body = String((m as { body?: string }).body ?? "");
        w.attempts.push({ key: opts.idempotencyKey, body });
        if (w.slowMs > 0) await new Promise((r) => setTimeout(r, w.slowMs));
        if (w.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        // A reserved key is answered from its reservation. Which words went is the adapter's to read
        // (its frozen PUT): that half is measured over the real adapter in send-past-a-day-goes-once.
        if (reserved.has(opts.idempotencyKey)) {
          return { changes: [], seq: null, firstSend: { status: "sent", at: NOW.toISOString() } };
        }
        reserved.set(opts.idempotencyKey, body);
        w.deliveries.push({ key: opts.idempotencyKey, body });
        return { changes: [], seq: null, providerMessageId: `<${opts.idempotencyKey}@x>` };
      },
    } as never,
  });
}

const PARENT = {
  id: "m-1", accountId: "acct-1", mailboxId: "mb", threadId: null, messageIdHeader: "<m-1@fake.test>",
  subject: "Invoice", from: { name: "Ada", address: "ada@fake.test" }, to: [], cc: [], date: NOW.toISOString(),
  folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
};
const seed = (store: MemoryMirrorStore) => store.applyChanges(["m-1", "m-2"].map((id) => (
  { type: "message", op: "create", id, seq: 1, updatedAt: NOW.toISOString(), entity: { ...PARENT, id, messageIdHeader: `<${id}@fake.test>` } }
)) as never);
const reply = (body: string) => ({
  kind: "mail_send", inReplyTo: "m-1", body, subject: "Re: Invoice",
  to: [{ name: null, address: "ada@fake.test" }], mailboxId: "mb",
});

type Released = Array<{ lane: string; source: string }>;
async function mount(engine: OhmailEngine, released: Released = [], said: string[] = []): Promise<{ press: (body: string, to?: string, andDone?: boolean) => Promise<void>; phase: () => string; code: () => string | null }> {
  const { useMailSend } = await import("@ohmail/app-logic/writing/mail-send");
  let api!: { press: (body: string, to?: string, andDone?: boolean) => Promise<void>; phase: () => string; code: () => string | null };
  const Probe = (): null => {
    const mail = useMailSend(engine as never, null, ((text: string) => { said.push(text); }) as never, useSendText(useTranslations() as unknown as Translator, scheduleLabel), (() => {}) as never,
      ((lane: string, _m: unknown, _ok: boolean, _p: unknown, detail?: { andDone?: { source: string } }) => {
        if (detail?.andDone) released.push({ lane, source: detail.andDone.source });
        return false;
      }) as never);
    api = {
      press: async (body, to = "m-1", andDone = false) => {
        const plan = { section: "new", source: to, messageIds: [to] };
        await act(async () => {
          (mail.send as unknown as (m: unknown, o: unknown) => void)({ ...reply(body), inReplyTo: to }, { surface: "inline", ...(andDone ? { andDone: plan } : {}) });
        });
      },
      phase: () => mail.stateOf("m-1").phase,
      code: () => (mail.stateOf("m-1") as { code?: string }).code ?? null,
    };
    return null;
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
  });
  return { press: (b, to, done) => api.press(b, to, done), phase: () => api.phase(), code: () => api.code() };
}
async function reload(): Promise<void> {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
}
const drain = async (): Promise<void> => {
  for (let i = 0; i < 24; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
};

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); window.localStorage.clear(); });
afterEach(async () => { await reload(); vi.useRealTimers(); });

/** A reply queued offline, the tab reloaded `later` ms on, the replay held on the wire, the reply pressed again. */
async function repressDuringReplay(first: string, again: string, later: number): Promise<Wire> {
  const w = wire();
  const store = new MemoryMirrorStore();
  await store.load();
  await seed(store);
  w.offline = true;
  const e1 = engineOver(store, w);
  const s1 = await mount(e1);
  await act(async () => { await e1.start(); });
  await s1.press(first);
  await drain();
  expect(s1.phase(), "the reply was not queued").toBe("queued");
  await reload();
  vi.setSystemTime(NOW.getTime() + later);
  w.offline = false;
  w.slowMs = 500;
  const e2 = engineOver(store, w);
  const s2 = await mount(e2, [], w.said);
  await act(async () => { void e2.start(); });
  await drain();
  expect(w.attempts.length, "the replay is not on the wire").toBe(2);
  await s2.press(again);
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  await drain();
  return w;
}

const counted = (w: Wire) => ({ keys: new Set(w.attempts.map((a) => a.key)).size, deliveries: w.deliveries.length });

describe("a reply re-pressed while the boot replay carries it", () => {
  it("the same words, an hour later: one key, one delivery", async () => {
    const w = await repressDuringReplay("Reply to Ada.", "Reply to Ada.", 60 * 60 * 1000);
    expect(counted(w), "a second key reached the wire, or the reply was delivered twice").toEqual({ keys: 1, deliveries: 1 });
  });

  for (const words of ["Reply to Ada.", "Reply to Ada, with the figures."]) it(`${words === "Reply to Ada." ? "the same" : "edited"} words, eight days later: the replay goes, one key, one delivery`, async () => {
    const w = await repressDuringReplay("Reply to Ada.", words, EIGHT_DAYS);
    expect(counted(w), "a week-old reply was held back, sent twice, or went under a second key").toEqual({ keys: 1, deliveries: 1 });
  });

  it("edited words, an hour later: one key, one delivery", async () => {
    const w = await repressDuringReplay("Reply to Ada.", "Reply to Ada, with the figures.", 60 * 60 * 1000);
    expect(counted(w), "a second key reached the wire, or the reply was delivered twice").toEqual({ keys: 1, deliveries: 1 });
  });
});

describe("a reply this tab held queued for more than a day", () => {
  it("goes once when the network is back, and pressing again sends nothing more", async () => {
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();
    await seed(store);
    w.offline = true;
    const e = engineOver(store, w);
    const s1 = await mount(e);
    await act(async () => { await e.start(); });
    await s1.press("Reply to Ada.");
    await drain();
    expect(s1.phase(), "premise: the reply was queued").toBe("queued");
    vi.setSystemTime(NOW.getTime() + 25 * 60 * 60 * 1000);
    w.offline = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await drain();
    expect({ ...counted(w), kept: e.abandoned().length }, "a day-old reply was held back").toEqual({ keys: 1, deliveries: 1, kept: 0 });
    await s1.press("Reply to Ada.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await drain();
    expect(w.deliveries, "the press after the send delivered it again").toHaveLength(1);
  });
});

describe("a reply re-pressed before the replay restored its row", () => {
  it("the row on disk is the standing send: edited words join its key, one delivery", async () => {
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();
    await seed(store);
    w.offline = true;
    const e1 = engineOver(store, w);
    const s1 = await mount(e1);
    await act(async () => { await e1.start(); });
    await s1.press("Reply to Ada.");
    await drain();
    expect(s1.phase(), "the reply was not queued").toBe("queued");
    await reload();
    w.offline = false;
    const e2 = engineOver(store, w);
    const s2 = await mount(e2);
    expect(e2.pendingMutations(), "premise: the row is not restored yet").toHaveLength(0);
    await s2.press("Reply to Ada, with the figures.");
    await act(async () => { await e2.start(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    await drain();
    expect(counted(w), "a second key reached the wire, or the reply was delivered twice").toEqual({ keys: 1, deliveries: 1 });
  });
});

describe("WEB-LIVE-FLUSH-DROPS-A-RESTORED-RELEASE", () => {
  it("a restored Send + Done confirmed by the live mount's flush is released once", async () => {
    const w = wire();
    const store = new MemoryMirrorStore();
    await store.load();
    await seed(store);
    w.offline = true;
    const e1 = engineOver(store, w);
    const s1 = await mount(e1);
    await act(async () => { await e1.start(); });
    await s1.press("Reply to Ada.", "m-1", true);
    await drain();
    expect(s1.phase(), "premise: the Send + Done was queued").toBe("queued");
    await reload();
    const released: Released = [];
    const e2 = engineOver(store, w);
    const s2 = await mount(e2, released);
    await act(async () => { await e2.start(); });
    await drain();
    await s2.press("Reply to Bo.", "m-2");
    await drain();
    w.offline = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await drain();
    expect({ deliveries: w.deliveries.length, released: released.filter((r) => r.source === "m-1").length },
      "the restored send's release was consumed by the live flush and lost").toEqual({ deliveries: 2, released: 1 });
  });
});

describe("REPRESS-OFFLINE-REPLY-SENDS-THE-EARLIER-WORDS on the web", () => {
  it("a waiting send whose newer words were kept back says the earlier version is going, once", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await seed(store);
    let answers = 0;
    const e = new OhmailEngine({
      store, now: () => new Date(Date.now()),
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: NOW.toISOString() }),
        fetchBody: async () => null,
        // The adapter's answer when the save over a row a send holds was refused and that send is still running.
        mutate: async () => {
          answers++;
          throw new MutationRejectedError("A send for this draft is already in progress.", {
            status: 409, code: "send_in_flight", retryable: true, details: { earlierWordsKept: true },
          });
        },
      } as never,
    });
    const said: string[] = [];
    const s1 = await mount(e, [], said);
    await act(async () => { await e.start(); });
    await s1.press("Words B, the edit.");
    await drain();
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await drain();
    expect({ answers: answers >= 2, going: said.filter((x) => x === messages.reply.toastEarlierGoing).length })
      .toEqual({ answers: true, going: 1 });
  });
});

