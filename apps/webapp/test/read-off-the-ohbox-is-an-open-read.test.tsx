/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ISO, act, answerConsentWith, goTo, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { LENA, click, key, mountThread, msg, patches, settle, toastText } from "./fixtures/thread-read-shell.js";
import { stubThreadLayout, type ThreadLayout } from "./fixtures/thread-layout.js";

/**
 * AN OHBOX MESSAGE READ IN THE READER OVER ANOTHER VIEW IS A READ IN OHMAIL (owner 2026-10-21:
 * "should be at the top when it was my last action"). The reader's Mark read over the Tag view, the
 * sender's view or History names the message as the row read (`readRow`), so the engine sends an
 * open read and the Ohbox files it at the top of Earlier. Before, only OhboxView held the row, so
 * the read kept its arrival slot. Nothing holds it off the Ohbox: no view there keeps the row.
 */

const tag = { type: "tag", op: "create", id: "tg1", seq: 900, updatedAt: ISO, entity: { id: "tg1", name: "Plans", hue: "blue", createdAt: ISO, updatedAt: ISO } };
/** "old" unread (08:00) under "newer" read (08:30), both tagged: New ["old"], Earlier ["newer"]. */
const two = (over: Record<string, unknown> = {}) => [
  msg("old", 0, { threadId: "t-old", labels: ["tg1"], ...over }),
  msg("newer", 30, { threadId: "t-newer", unread: false, labels: ["tg1"] }),
  tag,
];
const views = [
  ["the Tag view", "#/tag/tg1/m/old"],
  ["the sender's view", `#/address/${encodeURIComponent(LENA.address)}/m/old`],
  ["History", "#/history/m/old"],
] as const;
const ids = (label: string): string[] =>
  [...document.querySelectorAll(`[role="listbox"][aria-label="${label}"] .row[data-id]`)]
    .map((e) => (e as HTMLElement).dataset.id!);
/** The one reader on screen: the column, the sender's pane or the sheet. */
const slot = (): HTMLElement | null => {
  const all = document.querySelectorAll<HTMLElement>(".abar .abar-read");
  return all.length === 1 ? all[0]! : null;
};
const openReads = () => patches.filter((p) => (p as { openRead?: boolean }).openRead === true);
async function goOhbox(): Promise<void> {
  window.location.hash = "#/ohbox";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await settle();
}

beforeAll(async () => {
  await import("../app/shell/AppShell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => { installShellEnv(); });
afterEach(async () => { await teardownShellEnv(); });

describe("the reader's Mark read off the Ohbox is an open read", () => {
  for (const [label, hash] of views) {
    it(`in ${label}: an open read, and the Ohbox files it at the top of Earlier`, async () => {
      window.location.hash = hash;
      await mountThread(two());
      expect(slot()?.getAttribute("aria-label"), `the premise: ${label} shows old`).toBe("Mark read");
      await click(slot(), "Mark read");
      expect(patches.at(-1)).toEqual({ ids: ["old"], unread: false, openRead: true });
      await goOhbox();
      expect(ids("Earlier")).toEqual(["old", "newer"]);
      expect(ids("New"), "no hold is left behind").toEqual([]);
    }, 30_000);
  }

  it("the narrow sheet over the Tag view: an open read", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({
        matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {},
        addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
      }),
    });
    window.location.hash = "#/tag/tg1/m/old";
    await mountThread(two());
    const sheet = document.querySelector<HTMLElement>(".reader .abar .abar-read");
    expect(sheet?.getAttribute("aria-label"), "the premise: the sheet shows old").toBe("Mark read");
    await click(sheet, "Mark read");
    expect(patches.at(-1)).toEqual({ ids: ["old"], unread: false, openRead: true });
  }, 30_000);
});

describe("CONTROLS off the Ohbox", () => {
  it("Mark unread on a read message: no open read", async () => {
    window.location.hash = "#/tag/tg1/m/newer";
    await mountThread(two());
    expect(slot()?.getAttribute("aria-label")).toBe("Mark unread");
    await click(slot(), "Mark unread");
    expect(patches).toEqual([{ ids: ["newer"], unread: true }]);
  }, 30_000);

  it("a tagged News message: no open read", async () => {
    window.location.hash = "#/tag/tg1/m/old";
    await mountThread(two({ folder: "ohmail/News" }));
    expect(slot()?.getAttribute("aria-label")).toBe("Mark read");
    await click(slot(), "Mark read");
    expect(patches.at(-1)).toEqual({ ids: ["old"], unread: false });
    expect(openReads()).toEqual([]);
  }, 30_000);
});

/**
 * THE READ RULE IN EVERY READER (0.30.7's note said every message; it ran in the Ohbox only). In
 * History, a folder, a tag, the triage piles and the sheet over them, a letter opened, pressed in or
 * scrolled by hand turns read once its first lines have held on screen for the dwell and its sender
 * line or the end of its text was on screen, as a glance naming it as the row read. Stepping with the
 * keys, the first-row fallback and a link read nothing; Trash reads nothing. The reader is laid out
 * (`thread-layout.ts`) and the dwell is passed by hand.
 */
describe("the read rule in the readers off the Ohbox", () => {
  let layout: ThreadLayout;
  beforeEach(() => { layout = stubThreadLayout(); });
  afterEach(() => { layout.restore(); });
  const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
  const dwell = async (): Promise<void> => { await layout.passDwell(); await settle(); };
  const rowIn = (view: string, id: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`.view-${view} [role="listbox"] .row[data-id="${id}"]`);
  const panel = (id: string): HTMLElement | null =>
    layout.scroller()?.querySelector<HTMLElement>(`[data-conv-id="${id}"]`) ?? null;
  const unseen = (id: string): boolean => panel(id)?.hasAttribute("data-unseen") ?? false;
  const narrow = (): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
  };
  const press = async (el: Element | null | undefined): Promise<void> => {
    expect(el, "nothing to press").toBeTruthy();
    await act(async () => { el!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await settle();
  };
  /** Three of thread T, all tagged: the Tag view lists each, the column shows the conversation. */
  const tagged = () => [msg("p1", 0, { labels: ["tg1"] }), msg("p2", 10, { labels: ["tg1"] }), msg("p3", 20, { labels: ["tg1"] }), tag];
  const folder = { type: "folder", op: "create", id: "fd1", seq: 901, updatedAt: ISO, entity: { id: "fd1", name: "Projects", mailboxId: "mb_1", mailbox: "walker@example.invalid", updatedAt: ISO } };
  const filed = () => [msg("f1", 20, { threadId: "t-f1", folder: "Projects" }), msg("f2", 10, { threadId: "t-f2", folder: "Projects" }), folder];
  const later = (id: string, n: number) => msg(id, n, { threadId: `t-${id}`, triage: { id: `ms_${id}`, messageId: id, state: "reply_later", bubbleUpAt: null, setAt: ISO, updatedAt: ISO } });

  it("History: a click reads after the dwell, as a glance and an open read; the row and the panel turn read", async () => {
    window.location.hash = "#/history";
    await mountThread([msg("h1", 30, { threadId: "t-h1" }), msg("h2", 0, { threadId: "t-h2" })]);
    await dwell();
    expect(patches, "the first row the list shows is a preview").toEqual([]);
    await click(rowIn("history", "h2"), "h2's row");
    expect(patches, "nothing before the dwell").toEqual([]);
    await dwell();
    expect(patches).toEqual([{ ids: ["h2"], unread: false, via: "glance", openRead: true }]);
    expect(unseen("h2"), "the panel").toBe(false);
    expect(rowIn("history", "h2")?.hasAttribute("data-unseen"), "the row").toBe(false);
  }, 30_000);

  it("a tag's conversation: the clicked letter reads, an older one whose top stays reads after its own dwell, a pass reads nothing", async () => {
    window.location.hash = "#/tag/tg1";
    await mountThread(tagged());
    await click(rowIn("tag", "p3"), "p3's row");
    await dwell();
    expect(glances()).toEqual([["p3"]]);
    await layout.handScroll(layout.topOf("p1") - 10);
    await settle();
    await layout.handScroll(layout.topOf("p3") - 14);
    await settle();
    await dwell();
    expect(glances(), "p1 passed by inside the dwell").toEqual([["p3"]]);
    await layout.handScroll(layout.topOf("p2") - 10);
    await settle();
    await dwell();
    expect(glances()).toEqual([["p3"], ["p2"]]);
    expect(document.querySelector(".thread-marks"), "no squares off the Ohbox").toBeNull();
    expect(document.querySelector("[data-thread-read]"), "no tint off the Ohbox").toBeNull();
    expect(panel("p1")?.querySelector(".dot-unread"), "an unread sibling keeps its dot").not.toBeNull();
  }, 30_000);

  it("a link to a tagged letter is a preview until a press in it", async () => {
    window.location.hash = "#/tag/tg1/m/p3";
    await mountThread(tagged());
    expect(panel("p3"), "the link opened it").not.toBeNull();
    await dwell();
    expect(patches).toEqual([]);
    await press(panel("p3")?.querySelector(".msg-body, .pm-body"));
    await dwell();
    expect(glances()).toEqual([["p3"]]);
  }, 30_000);

  it("a folder: a click reads; ↑ to another row reads nothing; a press in the reader then reads", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    window.location.hash = "#/folder/fd1";
    await mountThread(filed());
    await click(rowIn("folder", "f1"), "f1's row");
    await dwell();
    expect(patches).toEqual([{ ids: ["f1"], unread: false, via: "glance" }]);
    // Read, f1 files under Earlier, below f2.
    await key("ArrowUp");
    expect(panel("f2"), "↑ shows f2").not.toBeNull();
    await dwell();
    expect(glances(), "a step is a preview").toEqual([["f1"]]);
    await press(panel("f2")?.querySelector(".msg-body, .pm-body"));
    await dwell();
    expect(glances()).toEqual([["f1"], ["f2"]]);
  }, 30_000);

  it("Answer Later: a click reads as a glance, and the letter stays in its pile", async () => {
    window.location.hash = "#/triage";
    await mountThread([later("a1", 20), later("a2", 10)]);
    await click(rowIn("triage", "a2"), "a2's row");
    await dwell();
    expect(patches).toEqual([{ ids: ["a2"], unread: false, via: "glance" }]);
    const sent = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map(([, init]) => String((init as RequestInit | undefined)?.body ?? ""));
    expect(sent.some((b) => b.includes("triage")), "no triage write").toBe(false);
    expect(rowIn("triage", "a2"), "still in Answer Later").not.toBeNull();
  }, 30_000);

  it("Mark unread on the bar is kept for the visit; a sibling's ⋯ offers Mark unread", async () => {
    window.location.hash = "#/tag/tg1";
    await mountThread([msg("p1", 0, { labels: ["tg1"], unread: false }), msg("p2", 10, { labels: ["tg1"] }), tag]);
    await click(rowIn("tag", "p2"), "p2's row");
    await dwell();
    expect(glances()).toEqual([["p2"]]);
    const slot = layout.scroller().querySelector<HTMLElement>(".abar .abar-read");
    expect(slot?.getAttribute("aria-label")).toBe("Mark unread");
    await click(slot, "Mark unread");
    expect(patches.at(-1)).toEqual({ ids: ["p2"], unread: true });
    await layout.handScroll(0);
    await layout.handScroll(layout.topOf("p2") - 14);
    await settle();
    await dwell();
    expect(glances(), "not read back").toEqual([["p2"]]);
    const more = panel("p1")?.querySelector(".msg-more");
    await click(more, "p1's ⋯");
    const item = panel("p1")?.querySelector<HTMLElement>('.msg-menu [role="menuitem"][data-item="mark_unread"]');
    expect(item, "the sibling's Mark unread").not.toBeNull();
    await click(item, "Mark unread");
    expect(patches.at(-1)).toEqual({ ids: ["p1"], unread: true });
  }, 30_000);

  it("the sheet over a tag at phone width: a tap reads after the dwell, and still with a key every 400 ms", async () => {
    layout.restore();
    layout = stubThreadLayout({ columnHidden: () => true });
    narrow();
    window.location.hash = "#/tag/tg1";
    await mountThread([msg("s1", 0, { threadId: "t-s1", labels: ["tg1"] }), msg("s2", 10, { threadId: "t-s2", labels: ["tg1"] }), tag]);
    await click(rowIn("tag", "s1"), "s1's row");
    expect(document.querySelector('.reader [data-conv-id="s1"]'), "the sheet shows it").not.toBeNull();
    await dwell();
    expect(glances()).toEqual([["s1"]]);
    await click(document.querySelector(".reader-close"), "Back");
    await click(rowIn("tag", "s2"), "s2's row");
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true, cancelable: true }));
        await vi.advanceTimersByTimeAsync(400);
      });
    }
    await settle();
    expect(glances(), "a hidden column's looks never start the sheet's dwell over").toEqual([["s1"], ["s2"]]);
  }, 30_000);

  it("the sheet raised by a link at phone width is a preview until a press", async () => {
    layout.restore();
    layout = stubThreadLayout({ columnHidden: () => true });
    narrow();
    window.location.hash = "#/history/m/h1";
    await mountThread([msg("h1", 0, { threadId: "t-h1" })]);
    expect(document.querySelector('.reader [data-conv-id="h1"]'), "the link raised the sheet").not.toBeNull();
    await dwell();
    expect(patches).toEqual([]);
    await press(document.querySelector('.reader [data-conv-id="h1"] .msg-body'));
    await dwell();
    expect(glances()).toEqual([["h1"]]);
  }, 30_000);

  for (const width of ["wide", "narrow"] as const) {
    it(`Trash (${width}): a click, a press and a scroll read nothing and say nothing`, async () => {
      if (width === "narrow") {
        layout.restore();
        layout = stubThreadLayout({ columnHidden: () => true });
        narrow();
      }
      const trashed = {
        id: "x1", accountId: "acct_live_1", mailboxId: "mb_1", threadId: "t-x1", folder: "Trash", subject: "Deleted",
        from: LENA, to: [], labels: [], unread: true, date: ISO, updatedAt: ISO, trashedAt: ISO, restoreTo: "INBOX",
      };
      await mountThread([msg("h1", 0, { threadId: "t-h1" }), msg("x1", 10, { threadId: "t-x1", folder: "Trash" })]);
      const inner = globalThis.fetch;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => String(input).includes("view=trash")
        ? new Response(JSON.stringify({ items: [trashed], nextCursor: null }), { status: 200, headers: { "content-type": "application/json" } })
        : (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init)) as typeof globalThis.fetch;
      await goTo("trash");
      await settle();
      await click(rowIn("trash", "x1"), "the deleted letter's row");
      expect(panel("x1"), "the reader shows it").not.toBeNull();
      await press(panel("x1")?.querySelector(".msg-body, .pm-body"));
      await layout.handScroll(30);
      await dwell();
      expect(patches).toEqual([]);
      expect(toastText()).toBe("");
    }, 30_000);
  }
});

describe("a hit opened from Search reads in a folder's column and in the sheet", () => {
  let layout: ThreadLayout;
  beforeEach(() => { layout = stubThreadLayout(); });
  afterEach(() => { layout.restore(); });
  const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
  const dwell = async (): Promise<void> => { await layout.passDwell(); await settle(); };
  const folder = { type: "folder", op: "create", id: "fd1", seq: 901, updatedAt: ISO, entity: { id: "fd1", name: "Projects", mailboxId: "mb_1", mailbox: "walker@example.invalid", updatedAt: ISO } };
  const kettle = (over: Record<string, unknown>) => msg("k1", 20, { threadId: "t-k1", subject: "Harbour kettle", ...over });
  const hit = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>('.view-search .hit-w[data-hit="k1"] button.hit-open');
  async function search(found: unknown): Promise<HTMLInputElement> {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (!/\/search\?/.test(String(input))) return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
      return new Response(JSON.stringify({ items: [found], total: 1, totalExact: true, ms: 4 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    await goTo("search");
    const box = document.querySelector<HTMLInputElement>(".view-search .search-box input")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(box, "harbour"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    await tick(1_000);
    await settle();
    expect(hit(), "the hit").not.toBeNull();
    return box;
  }
  const entity = (m: unknown) => (m as { entity: unknown }).entity;

  it("Return on a hit filed in Answer Later: the sheet opens it and reads it", async () => {
    const k1 = kettle({ triage: { id: "ms_k1", messageId: "k1", state: "reply_later", bubbleUpAt: null, setAt: ISO, updatedAt: ISO } });
    await mountThread([k1]);
    const box = await search(entity(k1));
    await act(async () => { box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    await settle();
    expect(document.querySelector('.reader [data-conv-id="k1"]'), "the sheet shows it").not.toBeNull();
    expect(patches, "nothing before the dwell").toEqual([]);
    await dwell();
    await dwell();
    expect(glances()).toEqual([["k1"]]);
  }, 60_000);

  it("a click on a hit in a folder: the folder's column reads it", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    const k1 = kettle({ folder: "Projects" });
    await mountThread([k1, msg("k0", 30, { threadId: "t-k0", folder: "Projects" }), folder]);
    await search(entity(k1));
    await click(hit(), "the hit");
    expect(window.location.hash).toContain("#/folder/fd1");
    expect(document.querySelector('.read-col [data-conv-id="k1"]'), "the column shows it").not.toBeNull();
    await dwell();
    await dwell();
    expect(glances()).toEqual([["k1"]]);
  }, 60_000);

  it("the same letter by link reads nothing", async () => {
    answerConsentWith({ foldersEnabledAt: ISO });
    window.location.hash = "#/folder/fd1/m/k1";
    await mountThread([kettle({ folder: "Projects" }), msg("k0", 30, { threadId: "t-k0", folder: "Projects" }), folder]);
    expect(document.querySelector('.read-col [data-conv-id="k1"]'), "the link opened it").not.toBeNull();
    await dwell();
    await dwell();
    expect(patches).toEqual([]);
  }, 60_000);
});
