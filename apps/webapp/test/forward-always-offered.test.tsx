// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { existsSync, readFileSync } from "node:fs";
import messages from "../messages/en.json";
import * as scan from "../../../scripts/lib/source-scan.mjs";

/**
 * FORWARD IS ALWAYS OFFERED (owner, 2026-09-25). A tax document the OTP vocabulary flagged
 * showed only Reply. Now: the dock opens on the one-sentence ask in place of the editor
 * (`ForwardAskStrip`), and every Forward entry point reads the ONE predicate, `forwardOffered`.
 */
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = new Date("2026-09-21T13:05:00.000Z");
/** Repo-root relative: under jsdom `import.meta.url` is not a `file:` URL (`compose-forward.test.ts`). */
const source = (rel: string): string => readFileSync(existsSync(rel) ? rel : `../../${rel}`, "utf8");

const flagged = {
  id: "m1", accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Steuererklärung 2025 – zur Prüfung", from: { name: "Treuhand", address: "office@example.invalid" },
  to: [], cc: [], date: "2026-09-21T13:05:00.000Z", folder: "INBOX", snippet: "preview", unread: false,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: true },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-21T13:05:00.000Z",
};

let host: HTMLDivElement | null = null;
let root: Root | null = null;
const calls: string[] = [];
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  host = null; root = null; calls.length = 0;
});

async function mountDock(forwardAsk: string | null): Promise<void> {
  const { MessagePane } = await import("../app/shell/MessagePane.js");
  const { MessageChromeProvider } = await import("../app/shell/message-chrome.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  host = document.createElement("div");
  host.className = "read-col";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider as never, {
        children: h(MessageChromeProvider as never, {
          value: {
            replyTo: "m1", replyMode: "forward", replyBody: { text: "", html: null },
            forwardAsk, confirmForward: () => { calls.push("confirm"); },
            onReplyBody: () => {}, closeReply: () => { calls.push("cancel"); }, sendReply: () => { calls.push("send"); },
            replySendState: () => ({ phase: "idle" }), openSenderMenu: () => {}, conversationOf: () => [],
            bodyOf: (m: Record<string, unknown>) => ({ text: m.snippet as string, state: "snippet" }),
            hydrateBody: () => {},
          },
          children: h(MessagePane as never, { message: flagged, tags: [], now: NOW, onAction: () => {} } as never),
        } as never),
      } as never),
    }));
  });
}

describe("the forward ask stands in the dock until it is answered", () => {
  it("says why the message was flagged and asks once — the editor is not there yet", async () => {
    await mountDock("otp");
    const ask = host!.querySelector<HTMLElement>('[role="alertdialog"].reply-ask');
    expect(ask, "a no_forward forward opened straight into the editor").not.toBeNull();
    expect(ask!.textContent).toContain(messages.reply.forwardAsk.otp);
    expect(ask!.getAttribute("aria-label")).toBe(messages.reply.forwardAsk.question);
    expect(host!.querySelector("[data-reply-for]"), "the editor mounted before the ask was answered").toBeNull();
    // Focus starts on the answer that sends nothing.
    expect(document.activeElement?.textContent).toBe(messages.reply.forwardAsk.cancel);
    const press = async (label: string) => {
      const b = [...ask!.querySelectorAll("button")].find((x) => x.textContent === label)!;
      await act(async () => { b.click(); });
    };
    await press(messages.reply.forwardAsk.confirm);
    await press(messages.reply.forwardAsk.cancel);
    expect(calls).toEqual(["confirm", "cancel"]);
  });

  it("with no ask pending the dock is the forward editor", async () => {
    await mountDock(null);
    expect(host!.querySelector(".reply-ask")).toBeNull();
    expect(host!.querySelector('[data-reply-for="m1"]')).not.toBeNull();
  });

  it("both catalogues carry every ask sentence", () => {
    const de = JSON.parse(source("apps/webapp/messages/de.json")) as typeof messages;
    const keys = ["otp", "verification", "password_reset", "security_alert", "sensitive", "question", "confirm", "cancel"];
    expect(Object.keys(messages.reply.forwardAsk).sort()).toEqual([...keys].sort());
    expect(Object.keys(de.reply.forwardAsk).sort()).toEqual([...keys].sort());
    for (const k of keys) expect((de.reply.forwardAsk as Record<string, string>)[k]).not.toBe((messages.reply.forwardAsk as Record<string, string>)[k]);
  });
});

/** Every Forward entry point, and the one predicate each must read. */
const DOORS: Array<[string, RegExp]> = [
  ["apps/webapp/app/shell/MessagePane.tsx", /canForward = forwardOffered\(message\)/],
  ["apps/webapp/app/shell/MessageCard.tsx", /chrome\.forward && forwardOffered\(message\)/],
  ["apps/webapp/app/shell/message-verbs.ts", /disabled: none \|\| !forwardOffered\(shown\)/],
  ["apps/webapp/app/shell/shell-keys.tsx", /disabled: !forwardOffered\(focused\)/],
  ["apps/mobile/src/ui/MessageActions.tsx", /forwardOffered: forwardOffered\(m\)/],
];
const code = (rel: string) => scan.withoutCommentsAndLiterals(source(rel));

describe("census: every Forward door reads the one helper", () => {
  it.each(DOORS)("%s gates Forward on forwardOffered and never on the flag or the mirror", (rel, gate) => {
    const src = code(rel);
    expect(src).toMatch(gate);
    // The two old gates, anywhere in the door's code: the flag and the mirror's answer.
    expect(src, `${rel} still reads no_forward`).not.toMatch(/no_forward/);
    expect(src, `${rel} still gates on the mirror`).not.toMatch(/mirrorHolds\??\.?\(/);
  });

  it("the press decides in forwardPress — the shell's openForward and the phone's reader model", () => {
    const shell = code("apps/webapp/app/shell/shell-compose.ts");
    expect(shell).toMatch(/const press = forwardPress\(m, held != null\)/);
    expect(code("apps/mobile/src/state/live.ts")).toMatch(/forwardAsk: forwardPress\(m\)\.ask/);
  });
});
