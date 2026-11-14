/** @vitest-environment jsdom */
/**
 * ═══ (VWR-4) — A DEAD SESSION IS NOT A BROKEN MESSAGE ═══════════════════════════════════
 *
 * Observed live: with the session dead, opening a message rendered "Couldn't load the full
 * message — showing the preview. Retry", and Retry just re-401'd — the reader told the MESSAGE
 * was broken when their SESSION was gone. The pane's failure note now reads the confirmed
 * session fact (`shell/session-truth.ts`) and, when the session is dead, names it and offers
 * the remedy that works (sign in) instead of the one that cannot (retry).
 *
 * And the inverse: a body failure recorded while the session was bad is re-asked on REVIVAL —
 * the 204-confirmed minting of a new session — so the failure does not outlive its cause.
 *
 * Harness follows `conversation.test.ts`: the real `MessagePane` through the real
 * `MessageChromeProvider`, with the chrome's body report as the mutation point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import {
  markSessionAlive,
  markSessionDead,
  resetSessionTruthForTests,
} from "@ohmail/app-logic/session/session-truth";

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-08-12T09:00:00.000Z");

function msg(id: string): Record<string, unknown> {
  return {
    id,
    accountId: "a",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `subject-${id}`,
    from: { name: `Sender ${id}`, address: `${id}@example.invalid` },
    to: [],
    cc: [],
    date: NOW.toISOString(),
    folder: "INBOX",
    snippet: `snippet-${id}`,
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
  };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let retried: Array<[string, { retry?: boolean } | undefined]> = [];

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

async function mountPane(bodyState: "failed" | "full"): Promise<void> {
  await unmount();
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(MessageChromeProvider as never, {
          value: {
            ownAddresses: [],
            replyTo: null,
            replyBody: { text: "", html: "" },
            onReplyBody: () => {},
            closeReply: () => {},
            sendReply: () => {},
            replySendState: () => ({ phase: "idle" }),
            openSenderMenu: () => {},
            conversationOf: () => [],
            bodyOf: (m: Record<string, unknown>) => ({
              text: m.snippet as string,
              state: bodyState,
              html: null,
              loadedRemoteContent: false,
              unsubscribe: "no_header",
              unsubscribeUrl: null,
            }),
            hydrateBody: (id: string, opts?: { retry?: boolean }) => { retried.push([id, opts]); },
            hydrateThread: () => {},
            openSubjectRule: () => {},
          },
          children: h(MessagePane as never, {
            message: msg("m1"),
            tags: [],
            now: NOW,
            onAction: () => {},
            onAddTag: () => {},
          } as never),
        } as never),
      }),
    );
  });
}

beforeEach(() => {
  resetSessionTruthForTests();
  retried = [];
});

afterEach(async () => {
  await unmount();
  resetSessionTruthForTests();
  vi.restoreAllMocks();
});

const note = (): HTMLElement | null => host!.querySelector<HTMLElement>(".msg-body-state");

describe("the body-failure note tells auth loss apart from content failure", () => {
  it("session alive: a failed body is a content failure, with Retry", async () => {
    await mountPane("failed");
    expect(note()).not.toBeNull();
    expect(note()!.textContent).toContain("Couldn't load the full message");
    expect(note()!.querySelector("button"), "the human retry disappeared").not.toBeNull();
    expect(note()!.querySelector('a[href="/login"]')).toBeNull();
  });

  it("session DEAD: the same failure names the session and offers sign-in, not a retry that re-401s", async () => {
    await mountPane("failed");
    await act(async () => {
      markSessionDead();
    });
    expect(note(), "the note vanished instead of re-labelling").not.toBeNull();
    expect(note()!.textContent).toContain("Your session ended, so the full message couldn't load.");
    expect(note()!.textContent).not.toContain("Couldn't load the full message");
    expect(note()!.querySelector('a[href="/login"]'), "no sign-in path on the auth-loss note").not.toBeNull();
    expect(note()!.querySelector("button"), "a Retry whose first press proves it a lie").toBeNull();
  });

  it("a REVIVAL re-asks a failed body once, as a retry — the failure must not outlive its cause", async () => {
    await mountPane("failed");
    expect(retried.filter(([, o]) => o?.retry === true)).toHaveLength(0);
    await act(async () => {
      markSessionAlive();
    });
    expect(
      retried.filter(([id, o]) => id === "m1" && o?.retry === true),
      "the revival never re-asked the failed body",
    ).toHaveLength(1);
  });

  it("a revival does NOT touch a healthy body — the re-ask is bounded to failures", async () => {
    await mountPane("full");
    await act(async () => {
      markSessionAlive();
    });
    expect(retried.filter(([, o]) => o?.retry === true)).toHaveLength(0);
  });
});
