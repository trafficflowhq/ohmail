/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { feedPartition, ohboxView } from "@ohmail/client-engine";
import { mountShell, stubDom, unmountAll } from "./_draft-shell.js";
import { d, mirrorOf, msg } from "./_ohbox-1-convergence.js";

const letter = (options: Parameters<typeof msg>[0]) => ({
  ...msg(options), accountId: "a1", mailboxId: "mb1",
});

beforeEach(() => {
  localStorage.clear();
  stubDom();
});

afterEach(async () => {
  await unmountAll();
  vi.unstubAllGlobals();
});

describe("a pinned row is drawn the same way wherever it is listed", () => {
  it("Reads draws the pinned issue unread, and the Ohbox pins the same message", async () => {
    const rows = [
      letter({ id: "issue-new", date: d(0), unread: true, folder: "ohmail/News" }),
      letter({
        id: "issue-pinned", date: d(1), unread: false, lastReadAt: d(0), folder: "ohmail/News",
        triage: { state: "resurfaced" },
      }),
      letter({ id: "issue-read", date: d(2), unread: false, lastReadAt: d(1), folder: "ohmail/News" }),
    ];
    const store = await mirrorOf(rows);
    expect(ohboxView(store).resurfaced.map((m) => m.id)).toEqual(["issue-pinned"]);
    const part = feedPartition(store, "reads");
    expect([...part.fresh, ...part.seen].map((m) => m.id)).toContain("issue-pinned");

    const { el } = await mountShell("#/reads", rows, [], { store });
    const news = within(within(el).getByRole("region", { name: "News" }));
    expect.soft(news.getByRole("option", { name: /Subject issue-pinned/ }).hasAttribute("data-unread")).toBe(true);
    expect(news.getByRole("option", { name: /Subject issue-read/ }).hasAttribute("data-unread")).toBe(false);

    await act(async () => {
      fireEvent.click(within(el).getByRole("button", { name: /^Ohbox/ }));
    });
    expect(within(el).getByRole("option", { name: /Subject issue-pinned/ }).hasAttribute("data-unread")).toBe(true);
  });
});

function pile(view: "reads" | "receipts") {
  const folder = view === "reads" ? "ohmail/News" : "ohmail/Receipts";
  return [
    letter({ id: "n0", date: d(0), unread: true, folder }),
    ...Array.from({ length: 4 }, (_, i) =>
      letter({ id: `r${i}`, date: d(i + 1), unread: false, lastReadAt: d(i + 1), folder })),
  ];
}

async function mountStaleLine(view: "reads" | "receipts") {
  const rows = pile(view);
  const store = await mirrorOf(rows, { view, newestSeenId: "r2" });
  const part = feedPartition(store, view);
  expect(part.fresh).toHaveLength(3);
  expect(part.newCount).toBe(1);
  const { el } = await mountShell(`#/${view}`, rows, [], { store });
  const place = view === "reads" ? "News" : "Receipts";
  const list = within(within(el).getByRole("region", { name: place }));
  return { el, list, place };
}

describe("the shell binds the position and the badge to different props", () => {
  const source = (path: string) => readFileSync(resolve(path), "utf8");

  it("Receipts' freshCount is the LINE's prefix, never the badge", () => {
    const model = source("packages/app-logic/src/streams/use-stream.ts");
    const list = source("packages/app/src/stream/StreamList.tsx");
    expect(model).toMatch(/freshCount: partition\.fresh\.length/);
    expect(model).not.toMatch(/freshCount: partition\.newCount/);
    expect(list).toMatch(/const fresh = model\.freshCount;/);
  });

  it("and the rail's two stream badges are the selector's own count", () => {
    const count = source("packages/app-logic/src/streams/rail-count.ts");
    expect(count).toMatch(/useGroundPartition\(FEED_OF\[place\]\)\.newCount/);
    for (const place of ["news", "receipts"]) {
      const seat = source(`packages/app/src/${place}/place.ts`);
      expect(seat).toContain(`const fresh = useStreamNew("${place}")`);
      expect(seat).toMatch(/count: String\(fresh\)/);
      expect(seat).toMatch(/useCount: use\w+Count/);
    }
  });

  it("the phone's dock reads the same field rather than counting rows itself", () => {
    const host = source("packages/app/src/frame/RailHost.tsx");
    const dock = source("packages/ui/src/mail/Shell/Dock.tsx");
    expect(host).toContain('["ohbox", "screener", "news", "receipts"]');
    expect(host).toMatch(/useCount: p\.rail!\.useCount/);
    expect(dock).toMatch(/const useCount = place\.useCount/);
    expect(dock).toMatch(/const counted = useCount\(\)/);
    expect(dock).not.toMatch(/items\.filter/);
  });

  it("the panes' own '{count} new' headline is the badge, not the line's position", async () => {
    const { list } = await mountStaleLine("reads");
    const header = within(list.getByRole("banner"));
    expect(header.getByText("1 new since you were here")).toBeTruthy();
    expect(header.queryByText("3 new since you were here")).toBeNull();
  });

  it("and Receipts' rendered headline is the badge while its list still slices at the position", async () => {
    const { el, list, place } = await mountStaleLine("receipts");
    const header = within(list.getByRole("banner"));
    expect(header.getByText("1 new since you were here")).toBeTruthy();
    expect(header.queryByText("3 new since you were here")).toBeNull();
    expect(within(el).getByRole("button", { name: "Receipts 1" })).toBeTruthy();

    const ids = (name: string) =>
      within(list.getByRole("listbox", { name })).getAllByRole("option").map((row) => row.dataset.id);
    expect(ids(place)).toEqual(["n0", "r0", "r1"]);
    expect(ids("Seen up to here")).toEqual(["r2", "r3"]);
  });

  it("Receipts' badge agrees between the phone and the selector", async () => {
    const rows = [
      letter({ id: "rc0", date: d(0), unread: true, folder: "ohmail/Receipts" }),
      ...Array.from({ length: 5 }, (_, i) =>
        letter({ id: `rc${i + 1}`, date: d(i + 1), unread: false, lastReadAt: d(i + 1), folder: "ohmail/Receipts" })),
      letter({ id: "rc-skipped", date: d(8), unread: true, folder: "ohmail/Receipts" }),
    ];
    const view = "receipts";
    const store = await mirrorOf(rows, { view, newestSeenId: "rc3" });
    const part = feedPartition(store, view);
    expect(part.fresh.map((m) => m.id)).toEqual(["rc0", "rc1", "rc2"]);
    expect(part.newCount).toBe(1);

    vi.stubGlobal("innerWidth", 390);
    stubDom({ narrow: true });
    const { el } = await mountShell("#/receipts", rows, [], { store });
    expect(within(el).getByRole("button", { name: `Receipts, ${part.newCount}` })).toBeTruthy();
  });
});
