/** @vitest-environment jsdom */
/**
 * A SUPERSEDED SEND SAYS NOTHING ON THE WEB (HIGH-1). An older send on the
 * wire, re-pressed under its key and failed retryably, answers `superseded`: the newer press owns
 * the key's one sentence. `absorb` read anything it did not know as `failed`, so a flush carrying
 * that answer would have said "not sent" and released the lane over a reply that is still going.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
/** No send is owed an ending in these jar-only cases — the shape every deletion had before keys could be owed. */
const NONE_OWED = (): boolean => false;

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-02T09:00:00.000Z");
const message: EngineMessage = {
  id: "m1",
  accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Werkstatt-Besuch?",
  from: { name: "Lena", address: "lena@atelier.example" },
  to: [], cc: [],
  date: NOW.toISOString(),
  folder: "INBOX",
  snippet: "…", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none",
  updatedAt: NOW.toISOString(),
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});
const drain = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => { setTimeout(r, 0); }); });
};

describe("a superseded answer on the web", () => {
  it("leaves a queued lane queued: no failure, no settlement, no sentence", async () => {
    const { useMailSend } = await import("@ohmail/app-logic/writing/mail-send");
    const { useMailSendText } = await import("../app/shell/mail-send-text.js");
    const settled: string[] = [];
    const toasts: string[] = [];
    const flushes: string[] = [];
    let api!: { send: (m: unknown) => void; stateOf: (k: string) => { phase: string } };
    const engine = {
      mutate: async () => ({ id: "i", key: "k1", seq: null, status: "queued", error: { code: "network", retryable: true } }),
      read: () => ({ get: () => message, list: () => [], entries: () => [], version: () => 1 }),
      flushPending: async () => { flushes.push("k1"); return [{ id: "i", key: "k1", seq: null, status: "superseded" }]; },
      pendingMutations: () => [],
      subscribe: () => () => { /* nothing here notifies */ },
      hasLateResults: () => false,
    };
    const Probe = (): null => {
      api = useMailSend(
        engine as never,
        null,
        ((m: string) => { toasts.push(m); }) as never,
        useMailSendText(), ((key: string) => { settled.push(key); }) as never,
      ) as never;
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
    });
    await act(async () => { api.send({ kind: "mail_send", inReplyTo: "m1", body: "Danke!" }); });
    await drain();
    expect(api.stateOf("m1").phase).toBe("queued");
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await drain();
    expect(flushes.length, "the flush that carries the answer never ran, so this measures nothing").toBeGreaterThan(0);
    expect(api.stateOf("m1").phase, "a superseded answer was read as a refusal").toBe("queued");
    expect(settled).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it("from the restore collector: the lane's durable lock is kept and nothing is said", async () => {
    const { useMailSend } = await import("@ohmail/app-logic/writing/mail-send");
    const { useMailSendText } = await import("../app/shell/mail-send-text.js");
    const { claimSendLock, recordForSendKey, SEND_LOCK_FORMAT } = await import("@ohmail/app-logic/writing/send-lock");
    claimSendLock({ v: SEND_LOCK_FORMAT, lane: "m1", key: "k9", at: Date.now(), draftId: null, fp: "fp-1", subject: "Re: Werkstatt-Besuch?" } as never, NONE_OWED, null);
    expect(recordForSendKey("k9", Date.now(), null), "no record, so the collector would skip it and this measures nothing").not.toBeNull();
    const toasts: string[] = [];
    const listeners: Array<() => void> = [];
    let late = true;
    const pulls: number[] = [];
    const engine = {
      mutate: async () => ({ id: "i", key: "k0", seq: null, status: "confirmed" }),
      read: () => ({ get: () => message, list: () => [], entries: () => [], version: () => 1 }),
      flushPending: async () => {
        pulls.push(1);
        if (!late) return [];
        late = false;
        return [{ id: "r", key: "k9", seq: null, status: "superseded" }];
      },
      pendingMutations: () => [],
      subscribe: (l: () => void) => { listeners.push(l); return () => { /* kept for the case */ }; },
      hasLateResults: () => late,
    };
    const Probe = (): null => {
      useMailSend(engine as never, null, ((m: string) => { toasts.push(m); }) as never, useMailSendText(), (() => {}) as never);
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", now: NOW, children: h(Probe) }));
    });
    await act(async () => { for (const l of listeners) l(); });
    await drain();
    expect(pulls.length, "the collector never pulled, so this measures nothing").toBeGreaterThan(0);
    expect(recordForSendKey("k9", Date.now(), null), "a superseded answer released the lane's lock").not.toBeNull();
    expect(toasts).toEqual([]);
  });
});
