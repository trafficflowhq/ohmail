/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { JUNK_REFILL_BOUND_MS, type EngineMessage, type MessageBody } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { StreamCardMemo } from "../app/shell/StreamCardMemo";

/**
 * STREAM-HUSK-MOVED-OUT-NOT-REASKED. A News or Receipts card over a Junk verdict's husk moved out
 * of the spam pile says "loading from your mail server" — and, like the reading pane, asks for the
 * body again once the mirror sheds the husk, and past the bound says it could not be read rather
 * than loading for ever. One hook for every reader (`useWithheldSentence`).
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;
const NOW = new Date("2026-09-16T09:00:00.000Z");
const m = {
  id: "m1", accountId: "a", mailboxId: "mb1", threadId: null, messageIdHeader: null,
  subject: "A receipt", from: { name: "Shop", address: "shop@example.invalid" }, to: [], cc: [],
  date: "2026-09-16T08:00:00.000Z", folder: "ohmail/Receipts", snippet: "s", unread: false, labels: [],
} as unknown as EngineMessage;

let roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(() => { r.unmount(); });
  roots = [];
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function card(onReask: (id: string) => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  const draw = (bodyState: MessageBody["state"]) => act(() => root.render(h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: NOW,
    children: h(StreamCardMemo, {
      m, now: NOW, current: false, expanded: true, viewer: true, unread: false,
      bodyText: "", bodyState, bodyHtml: null, bodyLoadedRemote: false,
      loadingLabel: messages.body.loading, failedLabel: messages.body.failed,
      withheldKey: "withheldJunkLoading", onReask,
      onSelect: () => {}, onToggle: () => {},
    }),
  })));
  return { host, draw };
}

describe("a stream card over a husk moved out of Junk", () => {
  it("asks for the body again once the husk sheds, and only once", async () => {
    const asked: string[] = [];
    const { host, draw } = await card((id) => asked.push(id));
    await draw("withheld");
    expect(host.textContent).toContain(messages.body.withheldJunkLoading);
    expect(asked).toEqual([]);
    await draw("loading");
    expect(asked, "the shed husk was never asked for again").toEqual(["m1"]);
    await draw("loading");
    expect(asked).toEqual(["m1"]);
  });

  it("past the bound it says the text could not be read", async () => {
    vi.useFakeTimers();
    const { host, draw } = await card(() => {});
    await draw("withheld");
    expect(host.textContent).toContain(messages.body.withheldJunkLoading);
    await act(async () => { vi.advanceTimersByTime(JUNK_REFILL_BOUND_MS + 1); });
    expect(host.textContent).toContain(messages.body.failed);
    expect(host.textContent).not.toContain(messages.body.withheldJunkLoading);
  });
});
