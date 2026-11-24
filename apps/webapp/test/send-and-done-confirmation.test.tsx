/** @vitest-environment jsdom */
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleLabel } from "@ohmail/app-logic/text/format";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { useMailSend } from "@ohmail/app-logic/writing/mail-send";
import { useSendText } from "@ohmail/app-logic/writing/mail-send-text";
import messages from "../messages/en.json";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  host = null;
  root = null;
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
}

describe("nothing is filed until the engine has confirmed the send", () => {
  it("a failed send answers the arm false; a confirmed one answers true", async () => {
    const answers: boolean[] = [];
    const toasts: string[] = [];
    const message = { id: "m1", folder: "INBOX", unread: true, triage: null };
    const reader = { get: () => message, list: () => [], entries: () => [], version: () => 1 };
    /** Rejects the first send, confirms the second — one engine, both outcomes. */
    let nth = 0;
    const engine = {
      mutate: async () => {
        nth += 1;
        return nth === 1
          ? { id: "i", key: `k${nth}`, seq: nth, status: "rolled_back", error: { code: "send_failed", retryable: false } }
          : { id: "i", key: `k${nth}`, seq: nth, status: "confirmed" };
      },
      read: () => reader,
      flushPending: async () => [],
      pendingMutations: () => [],
      subscribe: () => () => { /* nothing notifies */ },
      hasLateResults: () => false,
    };
    let api!: { send: (m: Record<string, unknown>) => void };
    const Probe = (): null => {
      api = useMailSend(
        engine as never,
        null,
        ((m: string) => toasts.push(m)) as never,
        useSendText(useTranslations() as unknown as Translator, scheduleLabel), (() => { /* the close is another case */ }) as never,
        ((_key: string, _m: unknown, accepted: boolean) => { answers.push(accepted); return accepted; }) as never,
      ) as never;
      return null;
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
        children: h(Probe),
      }));
    });

    await act(async () => { api.send({ kind: "mail_send", inReplyTo: "m1", body: "one" }); });
    await settle();
    expect(answers, "the failed send did not answer the arm").toEqual([false]);

    await act(async () => { api.send({ kind: "mail_send", inReplyTo: "m1", body: "two" }); });
    await settle();
    expect(answers).toEqual([false, true]);
    /* …and the lane kept its silence for the confirmed one, because the arm spoke. */
    expect(toasts).not.toContain("Reply sent.");
  });
});
