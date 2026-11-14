/** @vitest-environment jsdom */
/**
 * THE OPEN CONVERSATION'S SQUARES IN ITS OHBOX ROW, through today's shell (moved from `ohbox-thread-read`, where the
 * shipped row drew them as a strip of its own). The walked row draws the conversation as it stands, oldest first,
 * with the reader's ring on the same square as the column beside the reader at every step; a press on a square
 * scrolls the reader as the column's press does. Closed, the row keeps its ring where the person stopped, and a
 * press there opens the conversation and lands on that letter, nothing read. Another conversation chosen, the row
 * goes back to its own squares. Every row draws one group of squares in every state.
 *
 * The kit's squares carry their index (`data-square`) and their kind (`data-kind`); the ring is the one mark drawn
 * in a square. Geometry: tops 0/420/840/1260, p4 60px tall, the view 740, so the scroll's end is 620.
 *
 * RE-POINTED (share ohbox-2, the switch's older tests): the shell is the one there is (the shared fixtures mount
 * `_mail-shell.tsx`: the frame over the mail ground, the seated Ohbox and the reader). The reading column is the
 * frame's reading section; a letter is found by `data-conv-id`; the reader's ring is the square of the column of
 * squares beside the letters that the reader is on (`data-here`), by its place in the conversation. The column has no
 * close press: Escape closes the letter beside a list (point 64, DIFFERENCES-FROM-TODAY.md: "there is no ✕ on the
 * column"), so "the column's close" is Escape. At a phone's width the letter is the reading sheet and its way back is
 * the sheet's Back (named by the place it returns to); a phone's width is the window's (the frame lays its plan from
 * it) as well as the media query's. Expectations as they stood.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { answerStoreWith, installShellEnv, teardownShellEnv, tick } from "../fixtures/live-walk-shell.js";
import { ME, arriveLater, click, key, mountThread, msg, patches, readSlot, settle, theRow } from "../fixtures/thread-read-shell.js";
import { stubThreadLayout, type ThreadLayout } from "../fixtures/thread-layout.js";
import { letterShown, lettersShown, openLetter, readingColumn } from "./_finders.js";

const glances = () => patches.filter((p) => p.via === "glance").map((p) => p.ids);
const col = (): HTMLElement => readingColumn(document)!;
const panel = (id: string): HTMLElement | null => letterShown(document, id);
const bodies = (ids: string[]): void => answerStoreWith([], Object.fromEntries(ids.map((id) => [id, `the words of ${id}`])));
const four = () => [msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30)];
const ORDER = ["p1", "p2", "p3", "p4"];
/** Where a press on p2 lands: its top on the line (computed apart from the code under test). */
const P2_LANDS = 119;
const KIND: Record<string, string> = { unseen: "unread", seen: "read", own: "mine" };

const options = (host: ParentNode): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
const rowHolding = (host: ParentNode, id: string): HTMLElement | null =>
  options(host).find((r) => r.dataset.id === id || (r.dataset.ids ?? "").split(" ").includes(id)) ?? null;
/** A row's squares: the conversation's group in the row. */
const squaresOf = (row: Element | null): HTMLElement | null => row?.querySelector<HTMLElement>('[role="group"]') ?? null;
/** The walked row's squares: the one group in the list a press can jump with. */
const strip = (host: ParentNode): HTMLElement | null =>
  options(host).map(squaresOf).find((g): g is HTMLElement => g !== null && g.hasAttribute("data-press")) ?? null;
const slots = (group: Element | null): HTMLElement[] => [...(group?.querySelectorAll<HTMLElement>("[data-square]") ?? [])];
/** The square the ring stands in, as the letter it is (oldest first). */
const ringIn = (group: Element | null, order: readonly string[]): string | undefined => {
  /* A square holds its face, and the ring beside it where the reader stands. */
  const at = slots(group).find((s) => s.children.length > 1);
  return at === undefined ? undefined : order[Number(at.dataset.square)];
};
const stripRing = (host: ParentNode, order = ORDER): string | undefined => ringIn(strip(host), order);
const stripButton = (host: ParentNode, id: string, order = ORDER): HTMLElement | null =>
  slots(strip(host)).find((s) => Number(s.dataset.square) === order.indexOf(id)) ?? null;
const stripKinds = (host: ParentNode): string[] => slots(strip(host)).map((s) => KIND[s.dataset.kind ?? ""] ?? "?");
/** The column of squares beside the letters, by its name ("4 messages, 4 unread"): a group no row holds. */
const squaresColumn = (): HTMLElement | null =>
  [...(readingColumn(document)?.querySelectorAll<HTMLElement>('[role="group"]') ?? [])]
    .find((g) => /^\d+ messages, /.test(g.getAttribute("aria-label") ?? "") && g.closest('[role="option"]') === null) ?? null;
/** The letter the reader's ring stands on: the square the reader is on, by its place in the conversation. */
const ring = (): string | undefined => {
  const at = squaresColumn()?.querySelector<HTMLElement>("[data-square][data-here]")?.dataset.square;
  return at === undefined ? undefined : lettersShown(document)[Number(at)];
};
/** The column's close: Escape beside a list (point 64: the column draws no ✕). */
const closeColumn = (): Promise<void> => key("Escape");
/** The reading sheet's way back on a phone: its Back, named by the place it returns to ("Ohbox") or "Back". */
const sheetBack = (): HTMLElement | null =>
  [...(openLetter(document)?.querySelectorAll<HTMLElement>("button") ?? [])].find((b) =>
    /^(Back|Ohbox)$/.test(b.getAttribute("aria-label") ?? (b.textContent ?? "").trim())) ?? null;

let layout: ThreadLayout;

beforeAll(async () => {
  await import("../_mail-shell.js");
  await import("@ohmail/ui");
}, 120_000);
beforeEach(() => {
  installShellEnv();
  layout = stubThreadLayout();
  window.location.hash = "#/ohbox";
});
afterEach(async () => {
  layout.restore();
  await teardownShellEnv();
});

async function dwell(): Promise<void> {
  await layout.passDwell();
  await settle();
}

const shortLast = async (extra: unknown[] = []): Promise<HTMLElement> => {
  layout.restore();
  layout = stubThreadLayout({ heights: { p4: 60 } });
  bodies(["p1", "p2", "p3", "p4", "s1"]);
  return mountThread([...four(), ...extra]);
};

describe("a conversation's squares in its row", () => {
  it("one square per letter, oldest first, by kind; no thread count beside them", async () => {
    const host = await mountThread([msg("p1", 0), msg("p2", 10, { unread: false }), msg("p3", 20)]);
    const row = theRow(host)!;
    expect(slots(squaresOf(row)).map((s) => KIND[s.dataset.kind ?? ""])).toEqual(["unread", "read", "unread"]);
    expect(row.textContent, "the squares say the length").not.toMatch(/⤷/);
    expect(row.getAttribute("aria-description")).toContain("3 messages, oldest first: 2 unread");
  }, 30_000);

  it("the row speaks for the unread letter's sender while it opens on a newer read one", async () => {
    bodies(["l1", "l2"]);
    const host = await mountThread([msg("l1", 0), msg("l2", 10, { from: { name: "Bob", address: "lena@example.invalid" }, unread: false })]);
    const row = rowHolding(host, "l1")!;
    expect(row.dataset.id, "the row opens on its newest letter").toBe("l2");
    expect(row.getAttribute("aria-label"), "the row's voice is the unread sender's").toBe("Lena: Q3 plan");
  }, 30_000);
});

describe("the walked row's squares follow the reader's ring", () => {
  it("a scroll that zoomed text stops a fraction short of the end rings the one-line last, in the row too", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    for (const y of [619.6, 619.33, 619.1]) {
      await layout.handScroll(0);
      await settle();
      await layout.handScroll(y);
      await settle();
      expect(ring(), `at ${y}`).toBe("p4");
      expect(stripRing(host), `the row at ${y}`).toBe("p4");
    }
  }, 30_000);

  it("the open row carries the conversation's squares, ringed as the column at every step", async () => {
    const host = await shortLast();
    const row = theRow(host);
    await key("j");
    await key("Enter");
    expect(strip(host), "the squares of the open row take a press").not.toBeNull();
    expect(theRow(host), "the row was remounted (its focus lost) when its squares took the walk").toBe(row);
    expect(slots(strip(host)).length).toBe(ORDER.length);
    for (const y of [620, 0, 150, 300, 450, 620]) {
      await layout.handScroll(y);
      await settle();
      expect(stripRing(host), `at ${y}`).toBe(ring());
    }
  }, 30_000);

  it("a press on the row's square scrolls the reader as the column's press does, and opens nothing else", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await click(stripButton(host, "p2"), "p2 in the row");
    expect(layout.scroller().scrollTop).toBe(P2_LANDS);
    expect(ring()).toBe("p2");
    expect(stripRing(host)).toBe("p2");
  }, 30_000);

  it("closed, the row keeps its ring where the person stopped; a press there opens and lands on it, nothing read", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await layout.handScroll(300);
    await settle();
    const stopped = ring();
    expect(stopped).toBeDefined();
    await closeColumn();
    expect(openLetter(document), "the reader closed").toBeNull();
    expect(stripRing(host), "the row remembers the place").toBe(stopped);
    const before = glances().length;
    await click(stripButton(host, "p2"), "p2 in the row, nothing open");
    expect(panel("p2"), "the conversation opened").not.toBeNull();
    expect(layout.scroller().scrollTop, "landed on p2, not the newest").toBe(P2_LANDS);
    expect(ring()).toBe("p2");
    expect(glances().length, "nothing read by the landing").toBe(before);
  }, 30_000);

  it("closed, a reply that arrives gets its square, as in the row's own words", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await dwell();
    await closeColumn();
    expect(openLetter(document), "the reader closed").toBeNull();
    arriveLater([msg("p5", 40)], ["p1", "p2", "p3", "p4", "p5"]);
    await tick(20_000);
    await settle();
    expect(stripKinds(host).length, "the reply never arrived: the case is not exercised").toBe(5);
    expect(stripKinds(host)[4]).toBe("unread");
    const unread = stripKinds(host).filter((k) => k === "unread").length;
    expect(strip(host)?.closest('[role="option"]')?.getAttribute("aria-description"), "the squares draw the conversation as the row says it")
      .toContain(`5 messages, oldest first: ${unread} unread`);
  }, 60_000);

  it("closed, Mark unread on the conversation turns its squares, as in the row's own words", async () => {
    const host = await shortLast();
    await key("j");
    await key("Enter");
    await dwell();
    await click(readSlot(col()), "Mark read");
    /* The column closes first: Escape is the close beside a list (point 64), and with a pick standing the list's own
       Escape (the pick dropped) answers before it. Then the pick, so u reaches the conversation with the column closed. */
    await closeColumn();
    expect(openLetter(document), "the reader closed").toBeNull();
    await key("x"); // picked, so u reaches the conversation with the column closed
    expect(stripKinds(host)).toEqual(["read", "read", "read", "read"]);
    await key("u");
    const unread = stripKinds(host).filter((k) => k === "unread").length;
    expect(unread, "u never reached the squares").toBeGreaterThan(0);
    expect(strip(host)?.closest('[role="option"]')?.getAttribute("aria-description")).toContain(`4 messages, oldest first: ${unread} unread`);
  }, 30_000);

  it("selecting another conversation takes the walk off the row", async () => {
    const host = await shortLast([msg("s1", 40, { threadId: "S" })]);
    await click(rowHolding(host, "p4"), "the conversation's row");
    expect(strip(host)).not.toBeNull();
    await click(rowHolding(host, "s1"), "another conversation");
    expect(strip(host)?.closest('[role="option"]') ?? null, "the walk left with the conversation").not.toBe(rowHolding(host, "p4"));
  }, 30_000);

  /** Every row's groups of squares, as drawn: its own ("own") or the walked one ("strip"). */
  const groupsPerRow = (host: HTMLElement): Record<string, string[]> => Object.fromEntries(
    options(host).map((row) => {
      const drawn = [...row.querySelectorAll<HTMLElement>('[role="group"]')].map((g) => (g.hasAttribute("data-press") ? "strip" : "own"));
      return [(row.dataset.ids ?? row.dataset.id ?? "").split(" ").sort().join(" "), drawn];
    }),
  );
  const T = "p1 p2 p3 p4";
  const S = "s1 s2";
  it("one group of squares per row in every state: closed, opened, walked, closed again, another chosen, a reply, Mark unread", async () => {
    const host = await shortLast([msg("s1", 40, { threadId: "S" }), msg("s2", 41, { threadId: "S" })]);
    const expectRows = (state: string, rows: Record<string, string[]>): void => expect(groupsPerRow(host), state).toEqual(rows);
    expectRows("nothing open", { [T]: ["own"], [S]: ["own"] });
    await click(rowHolding(host, "p4"), "T's row");
    expectRows("T open", { [T]: ["strip"], [S]: ["own"] });
    await dwell();
    expectRows("T read", { [T]: ["strip"], [S]: ["own"] });
    for (const y of [0, 300, 620]) {
      await layout.handScroll(y);
      await settle();
      expectRows(`T walked to ${y}`, { [T]: ["strip"], [S]: ["own"] });
    }
    await closeColumn();
    expectRows("T closed, its place kept", { [T]: ["strip"], [S]: ["own"] });
    arriveLater([msg("p5", 50)], ["p1", "p2", "p3", "p4", "p5"]);
    await tick(20_000);
    await settle();
    const withReply = `${T} p5`;
    expect(Object.keys(groupsPerRow(host)), "the reply never arrived: the case is not exercised").toContain(withReply);
    expectRows("a reply into closed T", { [withReply]: ["strip"], [S]: ["own"] });
    await click(rowHolding(host, "s2"), "S's row");
    expectRows("S chosen", { [withReply]: ["own"], [S]: ["strip"] });
    await key("x");
    await key("u");
    expectRows("S picked and marked unread", { [withReply]: ["own"], [S]: ["strip"] });
  }, 60_000);

  it("an own reply among the squares opens its conversation on it, never a removed-elsewhere notice", async () => {
    const order = ["p1", "o1", "p3"];
    bodies(order);
    const host = await mountThread([
      msg("p1", 0), msg("o1", 15, { unread: false, folder: "Sent", from: { name: "Walker", address: ME } }), msg("p3", 20),
    ]);
    await key("j");
    await key("Enter");
    expect(stripButton(host, "o1", order), "the own reply has its square").not.toBeNull();
    expect(stripButton(host, "o1", order)?.dataset.kind).toBe("own");
    await closeColumn();
    await click(stripButton(host, "o1", order), "the own reply's square");
    expect(document.body.textContent ?? "", "a false 'removed elsewhere'").not.toMatch(/moved or deleted elsewhere/i); // the reader's gone words
    expect(panel("o1"), "the conversation is open").not.toBeNull();
    expect(ring()).toBe("o1");
  }, 30_000);
});

describe("at phone width, Back from a letter keeps the cursor on its row", () => {
  const wide = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: wide });
  });
  it("the row read wears the cursor, the focus and its walked squares after Back: a conversation, an unread letter, a read one", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true, writable: true,
      value: (query: string) => ({ matches: /max-width/.test(query), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false }),
    });
    const host = await mountThread([
      msg("p1", 0), msg("p2", 10), msg("p3", 20), msg("p4", 30),
      msg("w1", 40, { threadId: "W" }), msg("u1", 50, { threadId: "U" }), msg("l1", 5, { threadId: "L", unread: false }),
    ]);
    const order = (): string[] => options(host).map((r) => r.dataset.ids ?? r.dataset.id ?? "");
    expect(order()).toEqual(["u1", "w1", "p4 p3 p2 p1", "l1"]);
    const cursor = (): string[] => options(host).filter((r) => r.hasAttribute("data-open")).map((r) => r.dataset.ids ?? r.dataset.id ?? "");
    for (const [id, row] of [["p4", "p4 p3 p2 p1"], ["w1", "w1"], ["u1", "u1"], ["l1", "l1"]] as const) {
      await click(rowHolding(host, id), `${id}'s row`);
      expect(openLetter(document), `${id} opens in the sheet`).not.toBeNull();
      await dwell();
      await click(sheetBack(), "the sheet's Back");
      expect(cursor(), `after Back from ${id}`).toEqual([row]);
      expect(rowHolding(host, id)?.getAttribute("aria-selected"), `${id} is the selected option`).toBe("true");
      expect(document.activeElement, `focus on ${id}'s row`).toBe(rowHolding(host, id));
    }
    expect(order(), "w1 and u1 read and filed under Earlier, the last read first; T still has unread").toEqual(["p4 p3 p2 p1", "u1", "w1", "l1"]);
    expect(squaresOf(rowHolding(host, "p4"))?.hasAttribute("data-press"), "the conversation's walk left with the cursor").toBe(false);
    await click(rowHolding(host, "p4"), "T's row again");
    await click(sheetBack(), "Back");
    expect(squaresOf(rowHolding(host, "p4"))?.hasAttribute("data-press"), "T keeps its walked squares after Back").toBe(true);
  }, 60_000);
});

