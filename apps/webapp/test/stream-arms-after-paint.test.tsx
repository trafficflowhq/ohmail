/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, MessageBody, TagDTO, FeedPartition } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { ReadsView } from "../app/views/ReadsView";
import { ReceiptsView } from "../app/views/ReceiptsView";
import { KeymapProvider } from "../app/shell/keymap";

/**
 * THE ROWS PAINT BEFORE THE STREAM (`ReadsView`, `ReceiptsView`, `visit.ts#afterPaint`).
 *
 * The press commits the list and the stream's head; the cards follow once that frame has painted,
 * so the frame after a press is never held for a stream. jsdom lays nothing out, and with nothing
 * laid out there is no frame to paint first, so the stream arms at once there; this file gives the
 * stream a box (`getClientRects`) so the views take the browser's path. And a jump that arrives
 * before the cards do — a search hit opening News for the first time — waits for them, rather than
 * scrolling to a card that is not mounted yet and landing nowhere.
 *
 * Mutations watched red: arm the stream in the press's own commit (the first row); scroll the
 * pending jump whether or not the stream is armed (the jump row).
 */
const ISO = "2026-08-04T09:00:00.000Z";
const tags: TagDTO[] = [];
const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO,
  }) as unknown as EngineMessage;
const body = (): MessageBody =>
  ({ text: "body", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null } as unknown as MessageBody);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
let restore: (() => void) | null = null;
let streamScrolls = 0;
let originalScrollTo: unknown;

async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
        <KeymapProvider>{node}</KeymapProvider>
      </NextIntlClientProvider>,
    );
  });
  return host;
}

const frames = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))); });
  }
};

const N = 40;
const views = {
  News: (jumpTo: string | null = null) => {
    const partition: FeedPartition = { waterline: null, fresh: Array.from({ length: N }, (_, i) => message(i)), seen: [], newCount: 0 };
    return (
      <ReadsView settled owed={false} partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
        aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
        bodyOf={body} hydrateBody={() => {}} jumpTo={jumpTo} onJumped={() => {}} onAction={() => {}} />
    );
  },
  Receipts: (jumpTo: string | null = null) => (
    <ReceiptsView settled owed={false} messages={Array.from({ length: N }, (_, i) => message(i))} tags={tags} now={new Date(ISO)}
      cur={null} onCur={() => {}} unreadCount={0} isUnread={() => false} markSeen={() => {}}
      bodyOf={body} hydrateBody={() => {}} jumpTo={jumpTo} onJumped={() => {}} onAction={() => {}} />
  ),
};

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
  });
  (globalThis as unknown as { CSS?: { escape: (s: string) => string } }).CSS ??= { escape: (s: string) => s };
  (HTMLElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView ??= () => {};
  /* The stream's own scroll, recorded: a landing that ran is a scroll of the stream. */
  streamScrolls = 0;
  originalScrollTo = (HTMLElement.prototype as unknown as { scrollTo?: unknown }).scrollTo;
  (HTMLElement.prototype as unknown as { scrollTo: () => void }).scrollTo = function (this: HTMLElement) {
    if (this.classList.contains("stream")) streamScrolls += 1;
  };
  /* The stream has a box, as in a browser: the views wait for its first paint. */
  const proto = Element.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = function (this: Element) {
    if ((this as HTMLElement).classList?.contains("stream")) return [{ top: 0, bottom: 600, height: 600 }] as unknown as DOMRectList;
    return original.call(this);
  };
  restore = () => { proto.getClientRects = original; };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const r of roots) await act(() => r.unmount());
  roots = [];
  restore?.();
  restore = null;
  (HTMLElement.prototype as unknown as { scrollTo: unknown }).scrollTo = originalScrollTo;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

for (const [name, view] of Object.entries(views)) {
  describe(`${name}: the rows first, the stream after the paint`, () => {
    it("the press's own commit draws the rows and no card; the cards follow a frame later", async () => {
      const host = await mount(view());
      expect(host.querySelectorAll(".row").length, "the rows were not in the press's commit").toBeGreaterThan(0);
      expect(host.querySelector(".stream .stream-top"), "the stream's head is part of the first paint").not.toBeNull();
      expect(host.querySelectorAll(".scast").length, "the cards rode the press's own commit").toBe(0);
      await frames();
      expect(host.querySelectorAll(".scast").length, "the stream never armed").toBeGreaterThan(0);
    });

    it("a jump that arrives before the cards scrolls once they are there", async () => {
      const host = await mount(view("m30"));
      await frames(6);
      expect(host.querySelector('.scast[data-sid="m30"]'), "the jump's card never mounted").not.toBeNull();
      expect(streamScrolls, "the jump ran before its card existed and never scrolled the stream").toBeGreaterThan(0);
    });
  });
}
