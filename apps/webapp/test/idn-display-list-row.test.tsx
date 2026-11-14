/** @vitest-environment jsdom */

/**
 * AN INTERNATIONALIZED DOMAIN ON A LIST ROW, AS ITS OWNER WROTE IT: `idn-display.test.tsx`'s "a list row", moved here
 * unchanged so that its file holds only what stands over the new shell. This case still mounts today's stream card
 * (`StreamCardMemo`), which no host's entry reaches: it waits for the streams' mount (News), which re-points it at
 * the seated row and deletes this card.
 */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// A domain nobody owns, in the shape the report was about: `müller.example`.
const ACE = "xn--mller-kva.example";
const UNI = "müller.example";
const STORED = `sarada@${ACE}`;
const SHOWN = `sarada@${UNI}`;

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

let roots: Root[] = [];
let host: HTMLDivElement | null = null;

afterEach(async () => {
  for (const root of roots) await act(async () => { root.unmount(); });
  roots = [];
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("ACCEPTANCE: a list row", () => {
  it("prints the sender's readable address, and keeps the hue keyed on the stored one", async () => {
    const { StreamCardMemo } = await import("../app/shell/StreamCardMemo.js");
    const m = {
      id: "m1", accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null,
      subject: "Rechnung", from: { name: "Sarada", address: STORED }, to: [], cc: [],
      date: "2026-08-01T09:00:00.000Z", folder: "INBOX", snippet: "s", unread: false, labels: [],
    } as unknown as EngineMessage;

    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
          children: h(StreamCardMemo, {
            m, now: new Date("2026-08-02T09:00:00.000Z"),
            current: false, expanded: false, viewer: true, unread: false,
            bodyText: "body", bodyState: "full" as const, bodyHtml: null, bodyLoadedRemote: false,
            loadingLabel: "…", failedLabel: "!", withheldKey: "withheld", onReask: () => {},
            onSelect: () => {}, onToggle: () => {},
          }),
        }),
      );
    });

    expect(host.querySelector(".addr")?.textContent).toBe(SHOWN);
    expect(host.textContent, "the punycode form is still on the row").not.toContain("xn--");
  });
});
