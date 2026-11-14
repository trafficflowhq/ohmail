/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { qhFixtures, qhNorm } from "../../../packages/client-engine/test/quoted-history-fixtures.js";

/**
 * A STREAM CARD FOLDS ITS HISTORY TOO: the case of `quoted-history-render.test.tsx` that draws today's stream card
 * (`StreamCardMemo`), moved here as it stood (share reader-1) so that file reads only the letter's body, which stays;
 * it waits for the streams' mount (`WAITS:news`, its row).
 */
(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}
afterEach(unmount);

const textOf = (el: Element): string => qhNorm(el.textContent ?? "");
const srcdocText = (el: Element): string => {
  const doc = el.querySelector("iframe")?.getAttribute("srcdoc") ?? "";
  return qhNorm(new DOMParser().parseFromString(doc, "text/html").body.textContent ?? "");
};
const toggleIn = (el: Element): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>("button.msg-history-toggle");
const press = async (b: HTMLElement): Promise<void> => { await act(async () => { b.click(); }); };

const FIXTURES = qhFixtures();

describe("a Reads or Receipts stream card reads the message's subject too", () => {
  it("an Outlook FW: shows the letter it forwards; the hop below it folds", async () => {
    await unmount();
    const fx = FIXTURES.find((f) => f.id === "125")!;
    const { NextIntlClientProvider } = await import("next-intl");
    const { StreamCardMemo } = await import("../app/shell/StreamCardMemo.js");
    const en = (await import("../messages/en.json")).default;
    const now = new Date("2026-10-25T09:00:00.000Z");
    const m = {
      id: "m1", accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null, subject: fx.subject,
      from: { name: "Ben Sample", address: "ben.sample@example.org" }, to: [], cc: [], date: "2026-10-24T07:12:00.000Z",
      folder: "INBOX", snippet: "s", unread: false, labels: [],
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC", now,
        children: h(StreamCardMemo, {
          m: m as never, now, current: false, expanded: true, viewer: true, unread: false,
          bodyText: fx.text, bodyState: "full", bodyHtml: fx.html, bodyLoadedRemote: false,
          loadingLabel: "…", failedLabel: "!", withheldKey: "withheld" as never, onReask: () => {}, onSelect: () => {}, onToggle: () => {},
        }),
      }));
    });
    const shown = (): string => textOf(host!) + srcdocText(host!);
    expect(shown(), "the forwarded letter is on screen").toContain("we can load the second truck on Thursday");
    expect(shown()).not.toContain("can you take a second truck in the week of 9 November?");
    await press(toggleIn(host)!);
    expect(shown()).toContain("can you take a second truck in the week of 9 November?");
  });
});
