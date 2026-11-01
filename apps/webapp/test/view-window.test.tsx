/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineMessage, MessageBody, TagDTO, FeedPartition } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { OhboxView } from "../app/views/OhboxView";
import { ReadsView } from "../app/views/ReadsView";
import { ReceiptsView } from "../app/views/ReceiptsView";
import { KeymapProvider } from "../app/shell/keymap";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX } from "../app/shell/list-window";

/**
 * OHBOX · READS · RECEIPTS AT MAILBOX SCALE — the list column is a window, not the whole pile.
 *
 * A browser tab holds a windowed mirror; a standalone desktop client holds the whole mailbox,
 * tens of thousands of rows. Every one of these three views mapped its whole pile into the list
 * column on each visit — measured at mailbox scale, the Ohbox mounted every row and tens of thousands of nodes and
 * Reads/Receipts hundreds of thousands, which is the seconds a view switch was paying. History was windowed
 * for exactly this; these three now share the idiom (`useListWindow`).
 *
 * ── WHAT IS AND IS NOT WINDOWED ─────────────────────────────────────────────────────────────
 *
 * The LIST columns are windowed here. Reads and Receipts also render a reading STREAM — a card
 * per message — whose cards are variable-height, so `useListWindow`'s fixed-row arithmetic does
 * not fit them; the stream is bounded its own way, as a mounted opening run that grows toward
 * the reader and never unmounts (`stream-window.ts`). That seam has its own guards in
 * `stream-mount-window.test.tsx`; this file keeps the CSS half — mounted cards opt into
 * `content-visibility` — asserted as a CSS fact, exactly as History asserts its
 * scroll-anchoring opt-out.
 *
 * ── COUNTS, NOT TIMERS ──────────────────────────────────────────────────────────────────────
 *
 * A "under 200 ms" test flaps and gets deleted. What is invariant is the COUNT: a viewport's
 * worth of rows mount, and the thousands behind them are reserved height. Replacing any view's
 * `.slice(win.start, win.end)` with the full array turns the row-count assertions red.
 *
 * jsdom has no layout, so `clientHeight`/`offsetHeight` are 0 and the window's own fallbacks are
 * what run — `FALLBACK_VIEWPORT_PX` over `ESTIMATED_ROW_PX` — the same arithmetic a browser runs
 * with measured numbers. The constants are imported so a changed estimate does not pass here for
 * the wrong reason.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const ISO = "2026-08-04T09:00:00.000Z";
const N = 5000;
/**
 * The live Ohbox a truncation was reported against — the accepted messages on the seeded test
 * account. Kept as its own constant because the end-of-list guard below is about a REAL pile
 * whose end a reader can actually scroll to, not about the `N`-row stress size.
 */
const DEEP = 238;
const tags: TagDTO[] = [];
/**
 * The window's own arithmetic: the rows the viewport SPANS plus the overscan on each side that
 * exists — one of them at the top of the list. Matches history-window. The Ohbox mounts one row
 * fewer at the top because its "New for you" header is an item of the same index space.
 */
const SPAN = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1;
const ROWS_AT_TOP = SPAN + 8;
const ROWS_MOUNTED = SPAN + 16;

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

interface Mounted {
  host: HTMLElement;
  scroller: HTMLElement;
  rowIndices: () => number[];
  cardCount: () => number;
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
  return {
    host,
    scroller: host.querySelector(".list-col .scroller") as HTMLElement,
    rowIndices: () =>
      [...host.querySelectorAll(".list-col .row[data-id]")].map((n) =>
        Number((n.getAttribute("data-id") ?? "m-1").slice(1)),
      ),
    cardCount: () => host.querySelectorAll(".scast[data-sid]").length,
  };
}

async function scrollTo(m: Mounted, px: number): Promise<void> {
  m.scroller.scrollTop = px;
  await act(async () => {
    m.scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
}

const ohbox = (count: number) => {
  const half = Math.floor(count / 2);
  return (
    <OhboxView owed={false}
      demo={false}
      newForYou={Array.from({ length: half }, (_, i) => message(i))}
      previouslySeen={Array.from({ length: count - half }, (_, i) => message(i + half))}
      tags={tags} now={new Date(ISO)} selectedId={null} onSelect={() => {}} onEnterReader={() => {}}
      onMarkSeen={() => {}} readerId={null} readSetFor={(id: string) => [id]} doorbellInitials={[]} doorbellCount={0} settled
      onDoorbell={() => {}} onAction={() => {}} onAddTag={() => {}}
      bulk={{ run: () => true, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => true }}
      older={{ available: false, items: [], loading: false, error: null, exhausted: true, loadMore: () => {} }}
    />
  );
};

const reads = (count: number) => {
  const freshRows = Array.from({ length: count }, (_, i) => message(i));
  const partition: FeedPartition = { waterline: null, fresh: freshRows, seen: [], newCount: freshRows.filter((m) => m.unread).length };
  return (
    <ReadsView settled owed={false} partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
      aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
      bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}} onAction={() => {}} />
  );
};

const receipts = (count: number) => (
  <ReceiptsView settled owed={false} messages={Array.from({ length: count }, (_, i) => message(i))} tags={tags} now={new Date(ISO)}
    cur={null} onCur={() => {}} unreadCount={0} isUnread={() => false} markSeen={() => {}}
    bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}} onAction={() => {}} />
);

describe("Ohbox, Reads and Receipts render a windowed list, not a mailbox", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  for (const [name, render] of [
    ["Ohbox", ohbox],
    ["News", reads],
    ["Receipts", receipts],
  ] as const) {
    it(`${name}: mounts a viewport's worth of list rows at ${N}, not ${N}`, async () => {
      const m = await mount(render(N));
      const idx = m.rowIndices();
      // The load-bearing assertion — unwindowing the view makes this the whole pile.
      expect(idx.length).toBe(name === "Ohbox" ? ROWS_AT_TOP - 1 : ROWS_AT_TOP);
      expect(idx[0]).toBe(0);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    });

    it(`${name}: scrolling mounts rows under the thumb and unmounts those far above`, async () => {
      const m = await mount(render(N));
      await scrollTo(m, 300 * ESTIMATED_ROW_PX);
      const idx = m.rowIndices();
      expect(idx).toContain(300);
      expect(idx).not.toContain(0);
      expect(idx.length).toBe(ROWS_MOUNTED);
    });

    it(`${name}: a short list renders every row and reserves nothing`, async () => {
      const m = await mount(render(12));
      expect(m.rowIndices().length).toBe(12);
      expect(m.host.querySelectorAll(".list-col .rows > div[aria-hidden]").length).toBe(0);
    });

    /**
     * ═══ THE END OF THE LIST IS REACHABLE, AND NOTHING IS RESERVED PAST IT ═══════════════
     *
     * A live journey reported *"the LIST truncates … after scrolling far only a window of rows is
     * rendered"* against a full Ohbox. That count was the window doing its job — a windowed
     * list only ever holds its neighbourhood — and the message it was looking for turned out to
     * be a row near the end, because "Earlier" is ordered by READING time and not by date. Nothing was
     * truncated. But the reading of it was only cheap to refute because the arithmetic could be
     * checked by hand, and there was no guard saying the window reaches its own last row.
     *
     * So this is that guard, and it is the honest form of "deep scroll reaches the oldest row":
     * driven to the bottom, the list mounts its FINAL row and reserves no height below it. A
     * window that stopped a batch short — the failure the journey believed it had found — leaves
     * the last row unmounted with a spacer standing where mail should be, and that is a reader
     * who cannot reach the end of their own mailbox however far they scroll.
     *
     * MUTATION-WATCHED: `end` in `list-window.ts` capped at `count - 1` turns this red in all
     * three views (the last row never mounts) and leaves every other test in this file green.
     */
    it(`${name}: scrolled to the bottom, the list mounts its LAST row and reserves nothing below`, async () => {
      const m = await mount(render(DEEP));
      // The bottom of a scroller holding `DEEP` rows: total height less one viewport. jsdom has
      // no layout, so the window's own fallbacks are the geometry — the same arithmetic a
      // browser runs with measured numbers.
      await scrollTo(m, DEEP * ESTIMATED_ROW_PX - FALLBACK_VIEWPORT_PX);
      const idx = m.rowIndices();
      expect(
        idx[idx.length - 1],
        `the window stops short of the end: ${idx.length} rows mounted at the bottom of a ` +
          `${DEEP}-row list and the last of them is ${idx[idx.length - 1]}, not ${DEEP - 1}`,
      ).toBe(DEEP - 1);

      // …and no reserved height stands after it. A spacer below the final row is the list
      // claiming there is more mail below the mail it is showing.
      const rows = [...m.host.querySelectorAll(".list-col .row[data-id]")];
      const lastRow = rows[rows.length - 1]!;
      const below = [...m.host.querySelectorAll<HTMLElement>(".list-col .scroller [aria-hidden]")]
        .filter((d) => d.style.height !== "" && d.style.height !== "0px")
        .filter(
          (d) => (lastRow.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        );
      expect(
        below.map((d) => d.style.height),
        "height is reserved BELOW the last mounted row — the list says there is more mail " +
          "than it is willing to render",
      ).toEqual([]);
    });
  }

  /* A LETTER LISTED LATE NEVER TAKES THE CURSOR: with nothing picked, the row the list shows stays shown. */
  for (const [name, render] of [
    ["News", (rows: EngineMessage[]) => {
      const partition: FeedPartition = { waterline: null, fresh: rows, seen: [], newCount: rows.filter((m) => m.unread).length };
      return (
        <ReadsView settled owed={false} partition={partition} tags={tags} now={new Date(ISO)} cur={null} onCur={() => {}}
          aiChip={null} chipState={null} onChipState={() => {}} markSeen={() => {}}
          bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}} onAction={() => {}} />
      );
    }],
    ["Receipts", (rows: EngineMessage[]) => (
      <ReceiptsView settled owed={false} messages={rows} tags={tags} now={new Date(ISO)}
        cur={null} onCur={() => {}} unreadCount={rows.filter((m) => m.unread).length} isUnread={(m) => m.unread}
        markSeen={() => {}} bodyOf={body} hydrateBody={() => {}} jumpTo={null} onJumped={() => {}} onAction={() => {}} />
    )],
  ] as const) {
    it(`${name}: an unread letter listed late on top leaves the cursor on the letter shown`, async () => {
      const rows = [message(0), message(1), message(2)];
      const m = await mount(render(rows));
      const cursor = () => m.host.querySelector('.list-col .row[aria-selected="true"]')?.getAttribute("data-id");
      expect(cursor()).toBe("m0");
      const late = { ...message(9), unread: true } as EngineMessage;
      await act(() => {
        roots[roots.length - 1]!.render(
          <NextIntlClientProvider locale="en" messages={messages} now={new Date(ISO)} timeZone="UTC">
            <KeymapProvider>{render([late, ...rows])}</KeymapProvider>
          </NextIntlClientProvider>,
        );
      });
      expect(m.rowIndices()[0], "m9 listed on top").toBe(9);
      expect(cursor()).toBe("m0");
    });
  }

  /* The stream's own bound — an opening run that grows, never the whole pile — is guarded in
     `stream-mount-window.test.tsx`, beside the module that owns it. Here only the CSS half. */
  it("the streams opt into content-visibility, and the rule names the rendered card", async () => {
    const css = read("../app/app.css");
    expect(css).toMatch(/\.view-reads\s+\.stream\s+\.scast[\s\S]*?content-visibility:\s*auto/);
    const m = await mount(reads(24));
    expect(m.host.querySelector(".view-reads .stream .scast"), "the selector matches nothing").not.toBeNull();
  });
});
