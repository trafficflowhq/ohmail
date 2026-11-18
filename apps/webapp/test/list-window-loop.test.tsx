/** @vitest-environment jsdom */
import type { EngineMessage, MessageBody, TagEntity as TagDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ReceiptsView } from "../app/views/ReceiptsView";
import { KeymapProvider } from "@ohmail/app/keys";

/**
 * THE RECEIPTS "APPLICATION ERROR" — the windowed list must not measure its own leading row and
 * feed that measurement back into the arithmetic that CHOOSES the leading row.
 *
 * `useListWindow` measures the first rendered `.row` to keep its spacers honest. The first row of
 * a SCROLLED window is `all[start]`, and `start = floor(scrollTop / rowHeight)` — so if the leading
 * row's height differs from its neighbour's by even a pixel, setting `rowHeight` from it re-derives
 * `start`, which selects a DIFFERENT leading row, whose height re-sets `rowHeight`… React counts
 * the never-settling `setState` as a runaway and throws "Maximum update depth exceeded", which Next
 * paints as the whole-tab client-side "Application error" reported on opening Receipts.
 *
 * jsdom has no layout, so `offsetHeight` is 0 and the measurement never ran in any existing test —
 * which is exactly why this defect shipped. Here the rows are given a real, 1px-alternating height
 * (an amount pushes a receipt row a hair taller than its neighbour), the list is scrolled to a
 * boundary where the two candidate leading rows have the two heights, and the assertion is simply
 * that React does not loop. Freeze the measurement (`start === 0 || measured === 0`) and it is
 * green; take that guard away and both the throw and React's console runaway come back.
 */

const ISO = "2026-08-04T09:00:00.000Z";
const N = 5000;
const tags: TagDTO[] = [];

const message = (i: number): EngineMessage =>
  ({
    id: `m${i}`, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `subject of m${i}`, from: { name: `Sender ${i}`, address: `s${i}@x.invalid` },
    to: [], cc: [], date: ISO, folder: "INBOX", snippet: `snippet of message ${i}`,
    unread: false, hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null,
    labels: [], remoteContent: "none", updatedAt: ISO, amount: i % 2 ? "$1.00" : undefined,
  }) as unknown as EngineMessage;

const body = (): MessageBody =>
  ({ text: "body", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null } as unknown as MessageBody);

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];
const origOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

interface Mounted {
  scroller: HTMLElement;
}

async function mount(node: React.ReactNode): Promise<Mounted> {
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
  return { scroller: host.querySelector(".list-col .scroller") as HTMLElement };
}

async function scrollTo(m: Mounted, px: number): Promise<void> {
  m.scroller.scrollTop = px;
  await act(async () => {
    m.scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
}

const receipts = (count: number) => (
  <ReceiptsView settled owed={false} messages={Array.from({ length: count }, (_, i) => message(i))} tags={tags} now={new Date(ISO)}
    cur={null} onCur={() => {}} unreadCount={0} isUnread={() => false} markSeen={() => {}}
    bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}} onAction={() => {}} />
);

describe("the windowed Receipts list does not loop into an Application error", () => {
  beforeEach(() => {
    // A real, 1px-alternating row height — the only thing jsdom cannot give and the only thing
    // this defect needs. Everything else stays 0 (no layout), so the stream cards are inert
    // exactly as they are elsewhere in the suite.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList?.contains("row")) {
          const id = this.getAttribute("data-id") ?? "m0";
          return 80 + (Number(id.slice(1)) % 2);
        }
        return 0;
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    if (origOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", origOffsetHeight);
    else delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
    vi.restoreAllMocks();
  });

  it("does not run away when the window slides over rows of differing height", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { errs.push(String(a[0])); });
    const m = await mount(receipts(N)); // opens at the top — start 0, measures m0 once, stable

    let threw: unknown = null;
    try {
      // scrollTop 8100: at rowHeight 80 the leading row is m93 (81px); at 81 it is m92 (80px) —
      // the two-value oscillation the old guard let through.
      await scrollTo(m, 8100);
    } catch (e) {
      threw = e;
    }
    spy.mockRestore();

    expect(threw, "the windowed measurement fed back into the window and React looped to a crash").toBeNull();
    expect(errs.join("\n"), "React logged a max-update-depth runaway — the Receipts Application error")
      .not.toMatch(/Maximum update depth/);
  });
});
