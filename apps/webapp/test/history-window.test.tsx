/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { OhmailEngine, TagDTO } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { HistoryView as HistoryViewRaw } from "../app/views/HistoryView";
import { KeymapProvider } from "../app/shell/keymap";
import { WithListGone } from "./_list-gone";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX } from "../app/shell/list-window";
import { FIXTURE_NOW, idOf, storeFixture, storeMessage, storeRows } from "./_store-fixture";

/**
 * HISTORY IS THE STORE'S WHOLE TIMELINE, rendered as a window. The list is as long as the store's
 * total, rows arrive a page at a time from a fake store behind a REAL engine, the mirror paints
 * first and is replaced in place, and the month rail reaches the first message. Every assertion is
 * a count or an identity (jsdom has no layout: the window runs on its own fallbacks, imported).
 */

/* HistoryView declares the message verbs, so a bare mount brings its own keymap. */
const HistoryView = (props: React.ComponentProps<typeof HistoryViewRaw>) => (
  <KeymapProvider><WithListGone><HistoryViewRaw {...props} /></WithListGone></KeymapProvider>
);

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const N = 5000;
const SPAN = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1;
const ROWS_AT_TOP = SPAN + 8;
const ROWS_MOUNTED = SPAN + 16; // + 2 × overscan

const tags: TagDTO[] = [];
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

interface Mounted {
  host: HTMLElement;
  scroller: HTMLElement;
  /** The slots of the rows mounted, in document order, read back from their ids. */
  indices: () => number[];
  hydrated: string[];
}

const slotOf = (id: string): number => 0xffffffff - parseInt(id.slice(-12), 16);

async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function mountHistory(engine: OhmailEngine, settled = true): Promise<Mounted> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const hydrated: string[] = [];
  await act(() => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} now={FIXTURE_NOW} timeZone="UTC">
        <HistoryView onMarkSeen={() => {}}
          engine={engine}
          version={0}
          settled={settled}
          owed={false}
          tags={tags}
          now={FIXTURE_NOW}
          onOpen={() => {}}
          hydrateBody={(id) => { hydrated.push(id); }}
          onAction={() => {}}
          onAddTag={() => {}}
          onScreen={() => {}}
          canDelete={() => true}
          canReplyAll={() => true}
        />
      </NextIntlClientProvider>,
    );
  });
  const scroller = host.querySelector(".scroller") as HTMLElement;
  return {
    host, scroller, hydrated,
    indices: () => [...host.querySelectorAll(".row[data-id]")].map((n) => slotOf(n.getAttribute("data-id")!)),
  };
}

async function scrollTo(m: Mounted, px: number): Promise<void> {
  m.scroller.scrollTop = px;
  await act(async () => {
    m.scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 40));
  });
}

/** Scroll, then let the window walk the store until `slot` is on screen (or give up). */
async function scrollUntil(m: Mounted, px: number, slot: number): Promise<void> {
  await scrollTo(m, px);
  for (let i = 0; i < 40 && !m.indices().includes(slot); i++) await settle(1);
}

const metaOf = (m: Mounted): string | null => m.host.querySelector(".view-history .meta")?.textContent ?? null;

describe("History is the store's timeline, rendered as a window", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({
        matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const r of roots) await act(() => r.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("mounts a viewport's worth of rows over a store of thousands of messages, and states the store's count", async () => {
    const { engine } = await storeFixture(storeRows(N));
    const m = await mountHistory(engine);
    await settle();
    const idx = m.indices();
    expect(idx.length).toBe(ROWS_AT_TOP);
    expect(idx[0]).toBe(0);
    expect(metaOf(m)).toBe("5,000" + " messages");
    // The top spacer is always there (where slot 0 starts) and reserves nothing at the top.
    expect((m.host.querySelector(".rows > [data-window-top]") as HTMLElement).style.height).toBe("0px");
    const spacers = [...m.host.querySelectorAll(".rows > div[aria-hidden]:not([data-window-top])")] as HTMLElement[];
    expect(spacers.length).toBe(1);
    expect(spacers[0]!.style.height).toBe(`${(N - ROWS_AT_TOP) * ESTIMATED_ROW_PX}px`);
  });

  it("scrolling fetches the pages under the thumb, and the mounted count stays a window", async () => {
    const { engine } = await storeFixture(storeRows(N));
    const m = await mountHistory(engine);
    await settle();
    await scrollUntil(m, 300 * ESTIMATED_ROW_PX, 300);
    const idx = m.indices();
    expect(idx).toContain(300);
    expect(idx).not.toContain(0);
    expect(idx.length).toBe(ROWS_MOUNTED);
    const nodes = [...m.host.querySelectorAll(".rows > *")];
    expect(nodes.filter((n) => n.tagName === "BUTTON").length).toBe(ROWS_MOUNTED);
    // The page cache is the one bound on page rows, whatever was walked to get here.
    expect(engine.storePageCacheRows()).toBeLessThanOrEqual(150);
  });

  it("a pick reads in the column, and survives its page leaving the window and the cache", async () => {
    const { engine } = await storeFixture(storeRows(N));
    const m = await mountHistory(engine);
    await settle();
    await scrollUntil(m, 300 * ESTIMATED_ROW_PX, 300);
    const row = m.host.querySelector(`.row[data-id="${idOf(300)}"]`) as HTMLElement;
    await act(async () => { row.click(); await Promise.resolve(); });
    expect(m.host.querySelector(".read-col")!.textContent ?? "").toContain("subject of 300");
    expect(m.hydrated).toContain(idOf(300));
    await scrollUntil(m, 0, 0);
    expect(m.indices()).not.toContain(300);
    expect(m.host.querySelector(".read-col")!.textContent ?? "").toContain("subject of 300");
  });

  it("THE SWAP: the mirror paints first, page one replaces it in place, the count arrives with it", async () => {
    const rows = storeRows(200);
    const fx = await storeFixture(rows, { mirror: rows.slice(0, 40), held: true });
    const m = await mountHistory(fx.engine);
    await settle(2);
    const before = m.indices();
    expect(before[0]).toBe(0);
    expect(before.length).toBe(40);
    expect(metaOf(m), "no count while the store has not answered").toBeNull();
    await act(async () => { fx.release(); await Promise.resolve(); });
    await settle();
    const after = m.indices();
    // Same ids at the top — nothing moved — and the list is now the store's whole length: the
    // window mounts its top screenful, and the spacer below reserves every other slot of the 200.
    expect(after[0]).toBe(0);
    expect(after.slice(0, 10)).toEqual(before.slice(0, 10));
    expect(after).toEqual(Array.from({ length: ROWS_AT_TOP }, (_, i) => i));
    const spacers = [...m.host.querySelectorAll(".rows > div[aria-hidden]")] as HTMLElement[];
    expect(spacers.map((n) => n.style.height)).toEqual(["0px", `${(200 - ROWS_AT_TOP) * ESTIMATED_ROW_PX}px`]);
    expect(metaOf(m)).toBe("200" + " messages");
  });

  it("a store that does not answer says so, keeps the mirror's rows, and states no count", async () => {
    const rows = storeRows(30);
    const fx = await storeFixture(rows, { mirror: rows.slice(0, 12), timelineFails: true });
    const m = await mountHistory(fx.engine);
    await settle();
    expect(m.host.querySelector(".history-unanswered")?.textContent ?? "").toContain(messages.history.storeUnavailable);
    expect(m.indices().length).toBe(12);
    expect(metaOf(m)).toBeNull();
  });

  it("THE RAIL reaches the first message; opening it asks for its body", async () => {
    const rows = [
      ...Array.from({ length: 120 }, (_, i) => storeMessage(i, `2026-09-${String(20 - Math.floor(i / 10)).padStart(2, "0")}${"T"}10:00:00.000Z`)),
      ...Array.from({ length: 80 }, (_, i) => storeMessage(120 + i, `2025-03-${String(28 - Math.floor(i / 4)).padStart(2, "0")}${"T"}10:00:00.000Z`)),
      storeMessage(200, "2011-06-01T08:00:00.000Z", { subject: "the very first message" }),
    ];
    const fx = await storeFixture(rows);
    const m = await mountHistory(fx.engine);
    await settle();
    const items = [...m.host.querySelectorAll(".history-rail-item")] as HTMLButtonElement[];
    expect(items.map((b) => b.textContent)).toEqual(["Sep 2026", "Mar 2025", "Jun 2011"]);
    await act(async () => { items[2]!.click(); await Promise.resolve(); });
    for (let i = 0; i < 20 && !m.indices().includes(200); i++) await settle(1);
    expect(m.indices()).toContain(200);
    // The jump asked the store for that month at its own anchor — one request, not a walk.
    expect(fx.pages.some((p) => p?.date === "2011-06-01T08:00:00.000Z")).toBe(true);
    const first = m.host.querySelector(`.row[data-id="${idOf(200)}"]`) as HTMLElement;
    await act(async () => { first.click(); await Promise.resolve(); });
    expect(m.hydrated).toContain(idOf(200));
    expect(m.host.querySelector(".read-col")!.textContent ?? "").toContain("the very first message");
  });

  it("a walk toward a far slot never evicts what is on screen — its steps are not cached", async () => {
    const rows = [
      ...Array.from({ length: 400 }, (_, i) => storeMessage(i, new Date(Date.UTC(2026, 8, 20) - i * 60_000).toISOString())),
      ...Array.from({ length: 60 }, (_, i) => storeMessage(400 + i, new Date(Date.UTC(2021, 4, 20) - i * 60_000).toISOString())),
    ];
    const fx = await storeFixture(rows);
    const m = await mountHistory(fx.engine);
    await settle();
    const rail = [...m.host.querySelectorAll(".history-rail-item")] as HTMLButtonElement[];
    await act(async () => { rail[1]!.click(); await Promise.resolve(); });
    for (let i = 0; i < 20 && !m.indices().includes(400); i++) await settle(1);
    // Up into the newer month's tail, which only a walk from its start reaches.
    await scrollUntil(m, 385 * ESTIMATED_ROW_PX, 385);
    expect(m.indices()).toContain(385);
    // The older month's page, on screen the whole time, was fetched once and never evicted.
    expect(fx.served.filter((id) => id === idOf(400)).length, "the page on screen was asked again").toBe(1);
  });

  it("the mirror's live row wins over the page's; a row the mirror records deleted folds away", async () => {
    const rows = storeRows(20);
    const fx = await storeFixture(rows, { mirror: [{ ...rows[1]!, unread: true }, rows[2]!], mirrorDeletes: [rows[2]!.id] });
    const m = await mountHistory(fx.engine);
    await settle();
    expect(m.host.querySelector(`.row[data-id="${idOf(1)}"] .dot-unread`)).not.toBeNull();
    expect(m.host.querySelector(`.row[data-id="${idOf(3)}"] .dot-unread`)).toBeNull();
    expect(m.indices()).not.toContain(2);
    expect(m.host.querySelectorAll(".history-gone").length).toBe(1);
  });

  it("the demo, with no store doors, lists the mirror it is and counts it", async () => {
    const rows = storeRows(12);
    const fx = await storeFixture(rows, { mirror: rows, noDoors: true });
    const m = await mountHistory(fx.engine);
    await settle();
    expect(m.indices().length).toBe(12);
    expect(metaOf(m)).toBe("12 messages");
    expect([...m.host.querySelectorAll<HTMLElement>(".rows > div[aria-hidden]")].map((n) => n.style.height)).toEqual(["0px"]);
  });

  it("the windowed list opts out of scroll anchoring, and the rule names the right element", async () => {
    const css = read("../app/app.css");
    expect(css).toMatch(/\.view-history\s+\.rows\s*\{[^}]*overflow-anchor:\s*none/);
    const { engine } = await storeFixture(storeRows(5));
    const m = await mountHistory(engine);
    expect(m.host.querySelector(".view-history .rows")).not.toBeNull();
  });

  it("the shell hands History the engine and the mirror's version, never a mirror list", () => {
    const shell = read("../app/shell/AppShell.tsx");
    const block = shell.slice(shell.indexOf("<HistoryView"), shell.indexOf("/>", shell.indexOf("<HistoryView")));
    expect(block).toContain("engine={engine}");
    expect(block).toContain("version={derived}");
    expect(block).not.toContain("messages=");
    expect(block).not.toContain("windowed=");
  });
});
