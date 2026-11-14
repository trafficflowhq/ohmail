/** @vitest-environment jsdom */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { newsPlace } from "../../src/news/index.js";
import { receiptsPlace } from "../../src/receipts/index.js";
import { laterPlace, parkedPlace, resurfacePlace } from "../../src/piles/index.js";
import { fakeWindow } from "../support/fake-window.js";
import { letter, mountPiles, mountStream, pilesOf, said, streamInput } from "./world.js";

afterEach(cleanup);

/* jsdom scrolls nothing: a landing on an opened item is the browser file's to hold. */
function landsAnywhere(): void {
  const was = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = function () {} as typeof was;
  onTestFinished(() => {
    HTMLElement.prototype.scrollTo = was;
  });
}

const LETTERS = [
  letter("n1", { subject: "Issue 41", unread: true }),
  letter("n2", { subject: "Issue 40", unread: true }),
  letter("n3", { subject: "Issue 39", unread: false }),
];

describe("News, Receipts and the piles, each registered with the frame", () => {
  it("registers each place with its rail entry, its body and its panes", () => {
    expect(newsPlace).toMatchObject({
      id: "news",
      body: "news",
      rail: { group: "main", icon: "news", keyHint: "g r" },
    });
    expect(receiptsPlace).toMatchObject({
      id: "receipts",
      body: "receipts",
      rail: { group: "main", keyHint: "g e" },
    });
    for (const [place, key] of [
      [laterPlace, "g l"],
      [parkedPlace, "g p"],
      [resurfacePlace, "g b"],
    ] as const) {
      expect(place).toMatchObject({ body: "piles", rail: { group: "later", keyHint: key } });
      expect(place.panes).toMatchObject({ kind: "columns", Reading: "reader" });
      expect(place.panes.kind === "columns" && place.panes.room).toBeFalsy();
    }
    for (const place of [newsPlace, receiptsPlace]) {
      expect(place.panes.kind === "columns" && place.panes.Reading).not.toBe("reader");
      /* Their own column presses the reader's verbs through the frame's one seam: they ask for the room. */
      expect(place.panes).toMatchObject({ kind: "columns", room: true });
    }
  });

  it("mounts News alone in the frame: its rail entry with the new count, its list with the line, its stream", () => {
    mountStream({ place: "news", input: streamInput(LETTERS, said(), { fresh: 2 }) });
    const nav = screen.getByRole("navigation");
    expect(within(nav).getByText("News")).toBeTruthy();
    const list = screen.getByRole("region", { name: "News" });
    expect(within(list).getByText("2 new since you were here")).toBeTruthy();
    expect(within(list).getByText("Seen up to here")).toBeTruthy();
    expect(within(list).getByText("Issue 39")).toBeTruthy();
    const stream = screen.getByRole("region", { name: "News stream" });
    expect(within(stream).getByText("The words of n1.")).toBeTruthy();
    // The stand-in draws the words alone: no link stands that could open by itself.
    expect(stream.querySelectorAll("a")).toHaveLength(0);
  });

  it("counts what is new beside its title, keeps Mark all read in the list's menu, and says when the line was drawn", () => {
    // One letter below the line is still unread: what is new (above the line) and what is unread are two numbers.
    const letters = [LETTERS[0]!, LETTERS[1]!, letter("n3", { subject: "Issue 39", unread: true })];
    const input = streamInput(letters, said(), { fresh: 2 });
    const line = { ...input.partition.waterline!, at: "2026-11-09T17:40:00.000Z" };
    const seen = said();
    mountStream({
      place: "news",
      input: {
        ...streamInput(letters, seen, { fresh: 2, stamp: () => "row stamp" }),
        partition: { ...input.partition, waterline: line },
      },
    });
    const list = screen.getByRole("region", { name: "News" });
    const head = within(list).getByRole("banner");
    expect(within(head).getByText("2 new since you were here")).toBeTruthy();
    expect(within(head).queryByText("3 new since you were here")).toBeNull();
    // The head carries no Mark all read of its own: it stands in the list's menu.
    expect(within(head).queryByRole("button", { name: "Mark all read" })).toBeNull();
    fireEvent.click(within(head).getByRole("button", { name: "List" }));
    const all = screen.getByRole("menuitem", { name: /Mark all read/ });
    expect(all.textContent).toContain("3");
    fireEvent.click(all);
    expect(seen.all).toEqual([["n1", "n2", "n3"]]);
    // The line says when it was drawn, on the reader's own calendar.
    // A row says when in the list's own form, as the seat hands it; the stream's sheet keeps the clock.
    expect(within(list).getAllByText("row stamp").length).toBe(LETTERS.length);
    const heading = within(list).getByRole("heading", { name: /Seen up to here/ });
    expect(heading.textContent).toMatch(/\d{2}:40/);
  });

  it("draws a letter's words as words: a web address or markup in them is never a link in the stream", () => {
    const words = 'Read it at https://example.org/issue <a href="https://example.org/x">here</a>';
    mountStream({ place: "news", input: streamInput(LETTERS, said(), { text: () => words }) });
    const stream = screen.getByRole("region", { name: "News stream" });
    expect(within(stream).getAllByText(words).length).toBeGreaterThan(0);
    expect(stream.querySelectorAll("a, [href]")).toHaveLength(0);
    expect(within(stream).queryByRole("link")).toBeNull();
  });

  it("on a phone the place is the stream itself, under its head: the title, what is new and the list's menu", () => {
    mountStream({
      place: "news",
      input: streamInput(LETTERS, said(), { fresh: 2 }),
      window: fakeWindow("phone"),
    });
    const head = screen.getByRole("heading", { name: "News" }).closest("header")!;
    expect(within(head).getByText("2 new since you were here")).toBeTruthy();
    expect(within(head).getByRole("button", { name: "List" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "News stream" })).toBeTruthy();
  });

  it("shows a receipt's paper-clip on its row where it carries a file", () => {
    const letters = [
      letter("r1", { subject: "Invoice", hasAttachments: true, attachmentCount: 1 }),
      LETTERS[2]!,
    ];
    mountStream({ place: "receipts", input: streamInput(letters, said()) });
    const list = screen.getByRole("region", { name: "Receipts" });
    expect(list.querySelectorAll('[aria-label="Has an attachment"]')).toHaveLength(1);
  });

  it("mounts Receipts alone, with the way to older receipts in Search at its end", () => {
    const { address } = mountStream({ place: "receipts", input: streamInput(LETTERS, said()) });
    const stream = screen.getByRole("region", { name: "Receipts stream" });
    fireEvent.click(within(stream).getByRole("button", { name: "Older in Search" }));
    expect(address.read()).toMatch(/^#\/search/);
  });

  it("an empty stream says All read in its reading column, as the reference draws it, in both languages", () => {
    /* The blank's last word holds its full stop, so the words stand in two nodes of one line. */
    const line = (words: string) => (_: string, el: Element | null) =>
      el?.tagName === "P" && el.textContent === words;
    mountStream({ place: "news", input: streamInput([], said()) });
    expect(screen.queryByRole("region", { name: "News stream" })).toBeNull();
    expect(screen.getByText(line("All read"))).toBeTruthy();
    cleanup();
    mountStream({ place: "receipts", input: streamInput([], said()), lang: "de" });
    expect(screen.getByText(line("Alles gelesen"))).toBeTruthy();
  });

  it("an empty stream's list says Nothing here, as the reference draws it, in both languages", () => {
    /* The kit's empty part ends its words in its own dot: the words stand in one line of two nodes. */
    const line = (words: string) => (_: string, el: Element | null) =>
      el?.tagName === "P" && el.textContent === words;
    mountStream({ place: "news", input: streamInput([], said()) });
    expect(within(screen.getByRole("region", { name: "News" })).getByText(line("Nothing here"))).toBeTruthy();
    cleanup();
    mountStream({ place: "receipts", input: streamInput([], said()), lang: "de" });
    expect(
      within(screen.getByRole("region", { name: "Belege" })).getByText(line("Hier ist nichts")),
    ).toBeTruthy();
  });

  it("clips each item until it is pressed: Expand opens it whole and opens it, Collapse shuts it again", () => {
    landsAnywhere();
    const { address } = mountStream({ place: "news", input: streamInput(LETTERS, said(), { fresh: 2 }) });
    const stream = screen.getByRole("region", { name: "News stream" });
    const item = (id: string) => stream.querySelector(`[data-stream-item="${id}"]`) as HTMLElement;
    const control = (id: string) => within(item(id)).getByRole("button", { name: /Expand|Collapse/ });
    for (const m of LETTERS) expect(control(m.id).textContent).toContain("Expand");
    expect(control("n1").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(control("n1"));
    expect(address.read()).toBe("#/reads/m/n1");
    expect(control("n1").textContent).toContain("Collapse");
    expect(control("n1").getAttribute("aria-expanded")).toBe("true");
    expect(control("n2").textContent).toContain("Expand");
    fireEvent.click(control("n1"));
    expect(control("n1").textContent).toContain("Expand");
    expect(address.read()).toBe("#/reads/m/n1");
    // A press on the item itself opens it whole.
    fireEvent.click(within(item("n2")).getByText("The words of n2."));
    expect(address.read()).toBe("#/reads/m/n2");
    expect(control("n2").textContent).toContain("Collapse");
  });

  it("on a phone an item's control is Read in full, and it opens the letter", () => {
    landsAnywhere();
    const { address } = mountStream({
      place: "news",
      input: streamInput(LETTERS, said(), { fresh: 2 }),
      window: fakeWindow("phone"),
    });
    const stream = screen.getByRole("region", { name: "News stream" });
    const first = stream.querySelector('[data-stream-item="n1"]') as HTMLElement;
    const full = within(first).getByRole("button", { name: "Read in full" });
    expect(full.getAttribute("aria-expanded")).toBeNull();
    fireEvent.click(full);
    expect(address.read()).toBe("#/reads/m/n1");
  });

  it("keeps Mark all read offered while rows stand above the line with nothing unread: the press moves the line", () => {
    const read = LETTERS.map((m) => ({ ...m, unread: false }));
    const seen = said();
    mountStream({ place: "news", input: streamInput(read, seen, { fresh: 2 }) });
    const head = within(screen.getByRole("region", { name: "News" })).getByRole("banner");
    fireEvent.click(within(head).getByRole("button", { name: "List" }));
    const all = screen.getByRole("menuitem", { name: /Mark all read/ });
    expect(all).toHaveProperty("disabled", false);
    fireEvent.click(all);
    expect(seen.all).toEqual([[]]);
  });

  it("offers no Mark all read with nothing unread and no row above the line", () => {
    const read = LETTERS.map((m) => ({ ...m, unread: false }));
    mountStream({ place: "news", input: streamInput(read, said(), { fresh: 0 }) });
    const head = within(screen.getByRole("region", { name: "News" })).getByRole("banner");
    fireEvent.click(within(head).getByRole("button", { name: "List" }));
    expect(screen.getByRole("menuitem", { name: /Mark all read/ })).toHaveProperty("disabled", true);
  });

  it("says nothing of the pile while the mailbox is not settled", () => {
    mountStream({ place: "news", input: streamInput(LETTERS, said(), { fresh: 2, settled: false }) });
    expect(screen.queryByText("2 new since you were here")).toBeNull();
  });

  it("mounts the three piles as one body: the switch moves between them in place", () => {
    const later = [letter("l1", { subject: "Quote for the kiln" })];
    const parked = [letter("p1", { subject: "Lease draft" }), letter("p2", { subject: "Old invoice" })];
    const { address } = mountPiles({
      piles: pilesOf({ replyLater: later, setAside: parked }),
      letters: [...later, ...parked],
    });
    // One view, Triage; the switch says which pile stands.
    const head = screen.getByRole("heading", { name: /Triage/ });
    expect(head).toBeTruthy();
    expect(screen.getByText("Quote for the kiln")).toBeTruthy();
    const piles = screen.getByRole("group", { name: "Piles" });
    expect(
      within(piles)
        .getByRole("button", { name: /Answer Later/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(within(piles).getByRole("button", { name: /Parked/ }));
    expect(address.read()).toBe("#/triage/aside");
    expect(screen.getByText("Lease draft")).toBeTruthy();
    expect(screen.queryByText("Quote for the kiln")).toBeNull();
  });

  it("the switch says each pile's number in its words, an empty pile as 0", () => {
    const later = [letter("l1", { subject: "Quote for the kiln" })];
    const parked = [letter("p1", { subject: "Lease draft" }), letter("p2", { subject: "Old invoice" })];
    mountPiles({ piles: pilesOf({ replyLater: later, setAside: parked }), letters: [...later, ...parked] });
    const piles = screen.getByRole("group", { name: "Piles" });
    expect(
      within(piles)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Answer Later 1", "Parked 2", "Resurface 0"]);
    expect(within(piles).getByRole("button", { name: "Resurface 0" })).toBeTruthy();
  });

  it("says an empty pile once, in its list", () => {
    mountPiles({ piles: pilesOf({}), letters: [], at: "#/triage/resurface" });
    /* The kit's empty part: the words in one line of two nodes, its own dot at their end. */
    const line = (_: string, el: Element | null) =>
      el?.tagName === "P" && el.textContent === "Nothing set to come back";
    expect(screen.getAllByText(line)).toHaveLength(1);
  });

  it("speaks German on every place", () => {
    mountStream({ place: "news", input: streamInput(LETTERS, said(), { fresh: 2 }), lang: "de" });
    expect(screen.getAllByText("Bis hierher gesehen")).toHaveLength(2);
    expect(screen.getByText("2 neue seit deinem letzten Besuch")).toBeTruthy();
    cleanup();
    mountPiles({ piles: pilesOf({ replyLater: [LETTERS[0]!] }), letters: LETTERS, lang: "de" });
    expect(screen.getByRole("button", { name: /Antwortrunde/ })).toBeTruthy();
  });
});
