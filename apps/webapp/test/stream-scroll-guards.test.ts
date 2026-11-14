/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { NOW, message, mountShell, stubDom, unmountAll } from "./_draft-shell.js";

const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
const rowHeight = 80;
const listHeight = 600;

function letters(place: "Receipts" | "News", firstUnread = 0): EngineMessage[] {
  return ids.map((id, i) => message(id, {
    folder: `ohmail/${place}`,
    date: new Date(NOW.getTime() - i * 60_000).toISOString(),
    unread: i >= firstUnread,
  }));
}

function listRegion(el: HTMLElement, name: string): HTMLElement {
  return within(el).getByRole("region", { name });
}

function scroller(el: HTMLElement, name: string): HTMLElement {
  return listRegion(el, name).querySelector<HTMLElement>(".pl-scroll")!;
}

async function settle(): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(2500); });
}

beforeEach(() => {
  localStorage.clear();
  stubDom();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(NOW);
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: HTMLElement) {
    const list = this.closest<HTMLElement>(".pl-scroll");
    const at = ids.indexOf(this.dataset.id ?? "");
    if (!list || at < 0) return;
    const bottom = (at + 1) * rowHeight;
    list.scrollTop = Math.max(list.scrollTop, bottom - listHeight);
    fireEvent.scroll(list);
  });
});

afterEach(async () => {
  await unmountAll();
  vi.useRealTimers();
});

describe("Receipts is a flat list", () => {
  it("draws no day headings and no day rules — every receipt is one row in one list", async () => {
    const { el } = await mountShell("#/receipts", letters("Receipts"));
    const scroll = within(scroller(el, "Receipts"));
    const list = scroll.getByRole("listbox");
    expect(scroll.queryAllByRole("heading")).toEqual([]);
    expect(scroll.queryAllByRole("separator")).toEqual([]);
    expect(within(list).getAllByRole("option").map((row) => row.dataset.id)).toEqual(ids);
  });
});

describe("Receipts: a scroll nobody made must not write \\Seen", () => {
  it("a jump from another view moves the list to the selected receipt without reading on the way", async () => {
    const { el, engine, sent } = await mountShell("#/search", letters("Receipts"));
    await act(async () => {
      window.location.hash = "#/receipts/m/r15";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await settle();

    const list = listRegion(el, "Receipts");
    const target = within(list).getByRole("option", { name: "The colleague: Subject r15" });
    expect(target.getAttribute("aria-selected")).toBe("true");
    expect(scroller(el, "Receipts").scrollTop).toBe(16 * rowHeight - listHeight);
    expect(sent).toEqual([]);
    expect(ids.filter((id) => engine.read().get<EngineMessage>("message", id)?.unread)).toEqual(ids);
  });

  it("an untouched view marks NOTHING, and does not scroll itself either", async () => {
    const { el, sent } = await mountShell("#/receipts", letters("Receipts", 12));
    await settle();
    expect(sent).toEqual([]);
    expect(scroller(el, "Receipts").scrollTop).toBe(0);
  });

  it("a commit does not cause another commit — the fallback moves and nothing follows it", async () => {
    const { el, engine, sent } = await mountShell("#/receipts", letters("Receipts", 8));
    const read = { kind: "mark_seen", messageIds: ["r8"], unread: false, via: "glance" } as const;
    await act(async () => {
      await engine.mutate({ ...read, messageIds: [...read.messageIds] });
    });
    await settle();
    expect(sent).toEqual([read]);
    expect(scroller(el, "Receipts").scrollTop).toBe(0);
  });

  it("the guard is per-pane: a wheel over the reading stream marks no LIST rows", async () => {
    const { el, sent } = await mountShell("#/receipts", letters("Receipts"));
    const reading = within(el).getByRole("region", { name: "Receipts stream" });
    const readingScroll = reading.matches("[data-reading-scroll]") ? reading : reading.querySelector<HTMLElement>("[data-reading-scroll]")!;
    const list = scroller(el, "Receipts");
    fireEvent.wheel(readingScroll, { deltaY: 0 });
    list.scrollTop = 400;
    fireEvent.scroll(list);
    await settle();
    expect(list.scrollTop).toBe(400);
    expect(sent).toEqual([]);
  });
});

describe("Reads: the same two guards, on the view that shares the machinery", () => {
  it("an untouched view neither marks nor scrolls", async () => {
    const { el, sent } = await mountShell("#/reads", letters("News", 12));
    await settle();
    expect(sent).toEqual([]);
    expect(scroller(el, "News").scrollTop).toBe(0);
  });
});
