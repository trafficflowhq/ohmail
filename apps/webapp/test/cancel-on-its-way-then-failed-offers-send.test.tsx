/** @vitest-environment jsdom */
/**
 * A CANCEL TOLD "ON ITS WAY" WHOSE SEND THEN FAILS, ON THE WEB DOCK (a verifier's probe,
 * adopted): the dock says the send's own failure sentence, en and de, and offers Send again, rather
 * than closing silently over a message the person believes went.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { MutationRejectedError, OhmailEngine, MemoryMirrorStore, type EngineMutation } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const NOW = new Date("2026-10-06T03:00:00.000Z");
let root: Root | null = null;

type Held = "pending" | "sent" | "failed" | "withdrawn";
function engineOver(store: MemoryMirrorStore, ledger: Map<string, Held>, w: { attempts: number; withdraws: string[]; deliveries: number }): OhmailEngine {
  return new OhmailEngine({
    store, now: () => new Date(Date.now()),
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: NOW.toISOString() }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation, opts: { idempotencyKey: string }) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        w.attempts += 1;
        const held = ledger.get(opts.idempotencyKey);
        if (held === "pending") throw new MutationRejectedError("in progress", { status: 409, code: "send_in_flight", retryable: true });
        if (held === "failed") throw new MutationRejectedError("A prior send under this key failed and was not delivered.", { status: 409, code: "send_failed", retryable: false });
        if (held === "withdrawn") throw new MutationRejectedError("cancelled", { status: 409, code: "withdrawn", retryable: false });
        if (held === "sent") return { changes: [], seq: null, firstSend: { status: "sent", at: NOW.toISOString() } };
        ledger.set(opts.idempotencyKey, "pending");
        throw new MutationRejectedError("network failure: socket hang up", { code: "network", retryable: true });
      },
      withdrawSend: async (key: string) => {
        w.withdraws.push(key);
        const held = ledger.get(key);
        if (held === "pending") return { outcome: "in_flight" };
        if (held === "failed") return { outcome: "failed" };
        if (held === "sent") return { outcome: "already_sent", firstSend: { status: "sent", at: NOW.toISOString() } };
        ledger.set(key, "withdrawn");
        return { outcome: "withdrawn" };
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
const REPLY = { kind: "mail_send", inReplyTo: "m-1", body: "Thanks, Ada.", subject: "Re: Invoice", to: [{ name: null, address: "ada@fake.test" }], mailboxId: "mb" };

async function mount(engine: OhmailEngine, messages: AbstractIntlMessages, locale: string) {
  const { useMailSend, canSend } = await import("../app/shell/mail-send.js");
  const { SendStatus } = await import("../app/shell/SendStatus.js");
  let api!: { send: (m: unknown, o: unknown) => void; withdraw: (lane: string) => Promise<string>; state: () => { phase: string; code?: string }; canSend: () => boolean };
  const Probe = (): React.ReactElement => {
    const mail = useMailSend(engine as never, (() => {}) as never, (() => {}) as never, (() => false) as never);
    api = {
      send: (m, o) => (mail.send as unknown as (m: unknown, o: unknown) => void)(m, o),
      withdraw: (lane) => (mail.withdraw as unknown as (l: string) => Promise<string>)(lane),
      state: () => mail.stateOf("m-1") as { phase: string; code?: string },
      canSend: () => canSend(mail.stateOf("m-1") as never, REPLY as never),
    };
    return h("div", { id: "status" }, h(SendStatus, { send: mail.stateOf("m-1") as never, scope: "reply", lane: null, showing: null }));
  };
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(NextIntlClientProvider, { locale, messages, timeZone: "UTC", now: NOW, children: h(Probe) })); });
  return { api: () => api, text: () => host.querySelector("#status")?.textContent ?? "" };
}
const drain = async (): Promise<void> => { for (let i = 0; i < 24; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); }); };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); window.localStorage.clear(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.innerHTML = ""; vi.useRealTimers(); });

describe("a Cancel said on its way, then the send fails, on the web dock", () => {
  for (const [locale, messages] of [["en", en], ["de", de]] as const) {
    it(`${locale}: in_flight said on its way, the send then fails: the failure sentence and Send offered`, async () => {
      const store = new MemoryMirrorStore();
      await store.load();
      await store.applyChanges([{ type: "message", op: "create", id: "m-1", seq: 1, updatedAt: NOW.toISOString(), entity: PARENT }] as never);
      const ledger = new Map<string, Held>();
      const w = { attempts: 0, withdraws: [] as string[], deliveries: 0 };
      const engine = engineOver(store, ledger, w);
      const s = await mount(engine, messages as AbstractIntlMessages, locale);
      await act(async () => { await engine.start(); });
      await act(async () => { s.api().send(REPLY, { surface: "inline" }); });
      await drain();
      const queuedPhase = s.api().state().phase;
      const queuedText = s.text();
      let said = "";
      await act(async () => { said = await s.api().withdraw("m-1"); });
      const afterCancel = s.api().state().phase;
      for (const k of ledger.keys()) ledger.set(k, "failed");
      for (let i = 0; i < 30 && s.api().state().phase !== "failed"; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        await act(async () => { await engine.syncOnce().catch(() => undefined); });
        await drain();
      }
      const out = { queuedPhase, queuedText, said, afterCancel, phase: s.api().state().phase, code: s.api().state().code ?? null, text: s.text(), canSend: s.api().canSend(), withdraws: w.withdraws.length };
      const expected = (messages as { reply: { statusFailed: string } }).reply.statusFailed;
      expect(out).toMatchObject({ said: "already_sent", phase: "failed", code: "send_failed", text: expected, canSend: true });
    });
  }
});
