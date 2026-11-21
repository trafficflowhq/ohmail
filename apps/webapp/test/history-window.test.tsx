/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { within } from "@testing-library/react";
import type { OhmailEngine } from "@ohmail/client-engine";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX } from "@ohmail/app-logic/lists/list-window";
import { idOf, storeFixture, storeMessage, storeRows } from "./_store-fixture";
import {
  ISO, act, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";
import { ohboxRow, readingColumn, seatedList } from "./ohbox/_finders";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const N = 5000;
const SPAN = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1;
const ROWS_AT_TOP = SPAN + 8;
const ROWS_MOUNTED = SPAN + 16; // + 2 × overscan

interface Mounted {
  host: HTMLElement;
  scroller: HTMLElement;
  indices: () => number[];
}

const slotOf = (id: string): number => 0xffffffff - parseInt(id.slice(-12), 16);
const settle = (rounds = 4) => tick(rounds * 10);

async function mountHistory(engine: OhmailEngine): Promise<Mounted> {
  const host = await mountShell([mailbox({ lastSyncAt: ISO })], { engine });
  await goTo("history");
  const scroller = seatedList(host)!.querySelector<HTMLElement>(".pl-scroll")!;
  return {
    host, scroller,
    indices: () => [...scroller.querySelectorAll<HTMLElement>('[role="option"][data-id]')]
      .map((row) => slotOf(row.dataset.id!)),
  };
}

async function scrollTo(m: Mounted, px: number): Promise<void> {
  m.scroller.scrollTop = px;
  await act(async () => { m.scroller.dispatchEvent(new Event("scroll")); });
  await tick(40);
}

async function scrollUntil(m: Mounted, px: number, slot: number): Promise<void> {
  await scrollTo(m, px);
  for (let i = 0; i < 40 && !m.indices().includes(slot); i++) await settle(1);
}

const metaOf = (m: Mounted): string | null => seatedList(m.host)?.querySelector(".oh-listhead-count")?.textContent ?? null;

describe("History is the store's timeline, rendered as a window", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("mounts a viewport's worth of rows over a store of thousands of messages, and states the store's count", async () => {
    const { engine } = await storeFixture(storeRows(N));
    const m = await mountHistory(engine);
    await settle();
    const idx = m.indices();
    expect.soft(idx.length).toBe(ROWS_AT_TOP);
    expect(idx[0]).toBe(0);
    expect.soft(metaOf(m)).toBe(`${N.toLocaleString("en-US")} messages`);
    // The top spacer is always there (where slot 0 starts) and reserves nothing at the top.
    expect.soft(m.host.querySelector<HTMLElement>('[role="listbox"] > [data-window-top]')?.style.height).toBe("0px");
    const spacers = [...m.host.querySelectorAll('[role="listbox"] > div[aria-hidden]:not([data-window-top])')] as HTMLElement[];
    expect.soft(spacers.length).toBe(1);
    expect(spacers[0]?.style.height).toBe(`${(N - ROWS_AT_TOP) * ESTIMATED_ROW_PX}px`);
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
    const nodes = [...m.host.querySelectorAll('[role="listbox"] > *')];
    expect(nodes.filter((n) => n.getAttribute("role") === "option").length).toBe(ROWS_MOUNTED);
    // The page cache is the one bound on page rows, whatever was walked to get here.
    expect(engine.storePageCacheRows()).toBeLessThanOrEqual(150);
  });

  it("a pick reads in the column, and survives its page leaving the window and the cache", async () => {
    const { engine } = await storeFixture(storeRows(N));
    const hydrate = vi.spyOn(engine, "readBodyOffMirror");
    const m = await mountHistory(engine);
    await settle();
    await scrollUntil(m, 300 * ESTIMATED_ROW_PX, 300);
    const row = within(m.host).getByRole("option", { name: /subject of 300/i });
    await act(async () => { row.click(); await Promise.resolve(); });
    await settle();
    expect(readingColumn(m.host)!.textContent ?? "").toContain("subject of 300");
    expect(hydrate.mock.calls.map(([id]) => id)).toContain(idOf(300));
    await scrollUntil(m, 0, 0);
    expect(m.indices()).not.toContain(300);
    expect(readingColumn(m.host)!.textContent ?? "").toContain("subject of 300");
  });

  it("THE SWAP: the mirror paints first, page one replaces it in place, the count arrives with it", async () => {
    const rows = storeRows(200);
    const fx = await storeFixture(rows, { mirror: rows.slice(0, 40), held: true });
    const m = await mountHistory(fx.engine);
    await settle(2);
    const before = m.indices();
    expect(before[0]).toBe(0);
    expect(before.length).toBe(40);
    expect.soft(metaOf(m), "no count while the store has not answered").toBeNull();
    await act(async () => { fx.release(); await Promise.resolve(); });
    await settle();
    const after = m.indices();
    // Same ids at the top — nothing moved — and the list is now the store's whole length: the
    // window mounts its top screenful, and the spacer below reserves every other slot of the 200.
    expect(after[0]).toBe(0);
    expect(after.slice(0, 10)).toEqual(before.slice(0, 10));
    expect.soft(after).toEqual(Array.from({ length: ROWS_AT_TOP }, (_, i) => i));
    const spacers = [...m.host.querySelectorAll('[role="listbox"] > div[aria-hidden]')] as HTMLElement[];
    expect.soft(spacers.map((n) => n.style.height)).toEqual(["0px", `${(200 - ROWS_AT_TOP) * ESTIMATED_ROW_PX}px`]);
    expect(metaOf(m)).toBe("200" + " messages");
  });

  it("THE RAIL reaches the first message; opening it asks for its body", async () => {
    const rows = [
      ...Array.from({ length: 120 }, (_, i) => storeMessage(i, `2026-09-${String(20 - Math.floor(i / 10)).padStart(2, "0")}${"T"}10:00:00.000Z`)),
      ...Array.from({ length: 80 }, (_, i) => storeMessage(120 + i, `2025-03-${String(28 - Math.floor(i / 4)).padStart(2, "0")}${"T"}10:00:00.000Z`)),
      storeMessage(200, "2011-06-01T08:00:00.000Z", { subject: "the very first message" }),
    ];
    const fx = await storeFixture(rows);
    const hydrate = vi.spyOn(fx.engine, "readBodyOffMirror");
    const m = await mountHistory(fx.engine);
    await settle();
    const rail = within(within(m.host).getByRole("navigation", { name: "Month" }));
    expect(rail.getAllByRole("button", { name: /^\d{4}$/ }).map((b) => b.textContent))
      .toEqual(["2026", "2025", "2011"]);
    await act(async () => { rail.getByRole("button", { name: "2011" }).click(); });
    for (let i = 0; i < 20 && !m.indices().includes(200); i++) await settle(1);
    expect(m.indices()).toContain(200);
    // The jump asked the store for that month at its own anchor — one request, not a walk.
    expect(fx.pages.some((p) => p?.date === "2011-06-01T08:00:00.000Z")).toBe(true);
    const first = within(m.host).getByRole("option", { name: /the very first message/i });
    await act(async () => { first.click(); await Promise.resolve(); });
    await settle();
    expect(hydrate.mock.calls.map(([id]) => id)).toContain(idOf(200));
    expect(readingColumn(m.host)!.textContent ?? "").toContain("the very first message");
  });

  it("a walk toward a far slot never evicts what is on screen — its steps are not cached", async () => {
    const rows = [
      ...Array.from({ length: 400 }, (_, i) => storeMessage(i, new Date(Date.UTC(2026, 8, 20) - i * 60_000).toISOString())),
      ...Array.from({ length: 60 }, (_, i) => storeMessage(400 + i, new Date(Date.UTC(2021, 4, 20) - i * 60_000).toISOString())),
    ];
    const fx = await storeFixture(rows);
    const m = await mountHistory(fx.engine);
    await settle();
    const rail = within(within(m.host).getByRole("navigation", { name: "Month" }));
    await act(async () => { rail.getByRole("button", { name: "2021" }).click(); });
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
    expect(ohboxRow(m.host, idOf(1))?.getAttribute("data-unseen") ?? null).not.toBeNull();
    expect(ohboxRow(m.host, idOf(3))?.getAttribute("data-unseen") ?? null).toBeNull();
    expect(m.indices()).not.toContain(2);
  });

  it("the windowed list opts out of scroll anchoring, and the rule names the right element", async () => {
    const style = document.createElement("style");
    style.textContent = read("../../../packages/app/src/place-list/place-list.css");
    document.head.append(style);
    try {
      const { engine } = await storeFixture(storeRows(5));
      const m = await mountHistory(engine);
      expect(m.scroller.contains(within(m.host).getByRole("listbox", { name: "History" }))).toBe(true);
      expect(getComputedStyle(m.scroller).overflowAnchor).toBe("none");

      await goTo("address/" + encodeURIComponent("contact@example.invalid"));
      const ordinary = seatedList(m.host)?.querySelector<HTMLElement>(".pl-scroll");
      expect(ordinary).toBeTruthy();
      expect(getComputedStyle(ordinary!).overflowAnchor).not.toBe("none");
    } finally {
      style.remove();
    }
  });

  it("the shell hands History the engine and the mirror's version, never a mirror list", () => {
    const live = read("../../../packages/app-logic/src/history/live.ts");
    expect(live).toContain("const engine = useEngine()");
    expect(live).toContain("const derived = useDerivedVersion()");
    expect(live).toContain("useStoreTimeline(engine, derived, mirrorRows)");
  });
});
