/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, mountShell, stubDom, unmountAll, waitFor } from "./_draft-shell.js";
import { ESTIMATED_ROW_PX } from "@ohmail/app-logic/lists/list-window";

/**
 * DRAFTS MOUNTS ITS WINDOW, NOT EVERY DRAFT. The view mapped its scheduled sends and its drafts
 * whole; nothing bounds either. Both groups and the heading between them are one index space, the
 * Ohbox's shape: at every scroll stop the mounted items are one contiguous run of slots, each
 * row at its place, and a walk to the end mounts every row once in order. jsdom lays nothing out,
 * so the window runs on its estimate — which is what makes the slot arithmetic checkable here.
 */

const NOW = new Date("2026-08-07T15:00:00.000Z");
const draft = (i: number, over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: `d${i}`,
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: `draft ${i}`,
  body: "",
  to: [],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: new Date(NOW.getTime() - i * 1000).toISOString(),
  ...over,
});
const drafts = (n: number) => Array.from({ length: n }, (_, i) => draft(i));
const scheduled = (n: number) =>
  Array.from({ length: n }, (_, i) => draft(10_000 + i, { status: "scheduled", sendAt: new Date(NOW.getTime() + (i + 1) * 60_000).toISOString() }));

beforeEach(() => { localStorage.clear(); stubDom(); });
afterEach(unmountAll);

async function mount(d: EngineDraft[], s: EngineDraft[]): Promise<{ host: HTMLElement; scroller: HTMLElement }> {
  const shell = await mountShell("#/drafts", [], [...s, ...d]);
  await waitFor(() => shell.el.querySelector(".pl-scroll") !== null, "the Drafts list");
  const scroller = shell.el.querySelector<HTMLElement>(".pl-scroll")!;
  return { host: scroller, scroller };
}

async function scrollTo(scroller: HTMLElement, px: number): Promise<void> {
  scroller.scrollTop = px;
  await act(async () => {
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** The mounted items in document order: the slot each is stamped with, and what it is. */
const items = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>("[data-index]")].map((n) => ({
    slot: Number(n.dataset.index),
    what: n.dataset.id ?? `head:${n.closest("section")?.getAttribute("aria-label")}`,
  }));

/** The last row in its whole group, including the rows outside this screenful. */
const groupEnds = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[role="option"]')].filter(row =>
    row.hasAttribute("aria-setsize") && row.getAttribute("aria-posinset") === row.getAttribute("aria-setsize"));

describe("Drafts is a window over its scheduled sends and its drafts", () => {
  it("mounts a screenful of a long list, both headings in the index space", async () => {
    const { host } = await mount(drafts(300), scheduled(120));
    const first = items(host);
    expect(first.length, "every row was mounted — this list is not a window").toBeLessThan(60);
    expect(first[0]).toEqual({ slot: 0, what: "head:Scheduled" });
    expect(host.querySelectorAll("[role=option]").length).toBe(first.length - 1);
  });

  it("a walk to the end mounts every row once, in order, each at its slot", async () => {
    const { host, scroller } = await mount(drafts(300), scheduled(120));
    const seen = new Map<number, string>();
    const record = () => {
      const run = items(host);
      run.forEach((it, k) => {
        if (k > 0) expect(it.slot, "the mounted slots are one contiguous run").toBe(run[k - 1]!.slot + 1);
        const was = seen.get(it.slot);
        if (was !== undefined) expect(it.what, `slot ${it.slot}`).toBe(was);
        seen.set(it.slot, it.what);
      });
    };
    record();
    for (let top = 10 * ESTIMATED_ROW_PX; top <= 440 * ESTIMATED_ROW_PX; top += 10 * ESTIMATED_ROW_PX) {
      await scrollTo(scroller, top);
      record();
    }
    const slots = [...seen.keys()].sort((a, b) => a - b);
    expect(slots).toEqual(Array.from({ length: 422 }, (_, i) => i));
    expect(seen.get(0)).toBe("head:Scheduled");
    expect(seen.get(1)).toBe("d10000");
    expect(seen.get(120)).toBe("d10119");
    expect(seen.get(121)).toBe("head:Drafts");
    expect(seen.get(122)).toBe("d0");
    expect(seen.get(421)).toBe("d299");
  });

  it("with nothing scheduled there is no heading: slot 0 is the first draft", async () => {
    const { host } = await mount(drafts(200), []);
    expect(items(host)[0]).toEqual({ slot: 0, what: "d0" });
    expect(host.querySelector("h2")).toBeNull();
  });

  it("an empty drafts group keeps its heading and its empty state below the scheduled sends", async () => {
    const { host } = await mount([], scheduled(3));
    expect(items(host).map((i) => i.what)).toEqual(["head:Scheduled", "d10000", "d10001", "d10002", "head:Drafts"]);
    const heads = [...host.querySelectorAll("h2")];
    const empty = host.querySelector(".oh-empty");
    expect(empty).not.toBeNull();
    expect(heads[1]!.compareDocumentPosition(empty!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("an empty Drafts with nothing scheduled says so", async () => {
    const { host } = await mount([], []);
    expect(host.querySelector(".oh-empty")).not.toBeNull();
    expect(items(host)).toEqual([]);
  });

  it("the last row of each group is marked, not the last one mounted", async () => {
    const { host, scroller } = await mount(drafts(300), scheduled(120));
    expect(groupEnds(host).length).toBe(0);
    // Mid-way through each group the last MOUNTED row is not the group's last row.
    for (const slot of [60, 250]) {
      await scrollTo(scroller, slot * ESTIMATED_ROW_PX);
      expect(groupEnds(host).length, `at slot ${slot}`).toBe(0);
    }
    await scrollTo(scroller, 119 * ESTIMATED_ROW_PX);
    expect(groupEnds(host).map((row) => [row.dataset.id, row.getAttribute("aria-setsize")])).toEqual([["d10119", "120"]]);
    await scrollTo(scroller, 440 * ESTIMATED_ROW_PX);
    expect(groupEnds(host)[0]?.getAttribute("aria-setsize")).toBe("300");
    const last = groupEnds(host).map((n) => n.dataset.id);
    expect(last).toEqual(["d299"]);
  });
});
