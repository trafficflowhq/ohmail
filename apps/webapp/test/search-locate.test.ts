/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openTargetFor, type OpenTarget } from "@ohmail/app-logic/search/open-target";
import { screen, within } from "@testing-library/react";
import { rowOf } from "../../../packages/app/src/ohbox/keyboard.js";
import { act, goTo, installShellEnv, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { click, mountThread, msg as threadMessage, settle } from "./fixtures/thread-read-shell.js";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

function msg(over: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id: "m-1",
    folder: "INBOX",
    from: { name: "Lena", address: "lena@example.invalid" },
    labels: [],
    unread: true,
    subject: "s",
    snippet: "",
    date: "2026-08-04T09:00:00.000Z",
    ...over,
  } as unknown as EngineMessage;
}

/** No Screener row is held for this sender — the arm that must not select nothing. */
const noRow = (): string | null => null;
const someRow = (): string => "sender-row-7";

describe("the decision: every view a hit can land in", () => {
  const cases: Array<[string, string, OpenTarget]> = [
    ["the Ohbox", "INBOX", { kind: "ohbox", id: "m-1", reader: false }],
    ["News", "ohmail/News", { kind: "stream", view: "reads", id: "m-1" }],
    ["Receipts", "ohmail/Receipts", { kind: "stream", view: "receipts", id: "m-1" }],
  ];

  for (const [name, folder, expected] of cases) {
    it(`${name} — the cursor is the message itself`, () => {
      expect(openTargetFor(msg({ folder: folder as EngineMessage["folder"] }), false, noRow)).toEqual(expected);
    });
  }

  it("the Screener — the cursor is the SENDER's row, not the message", () => {
    // The Screener lists senders. A hit is a message, so locating it means locating the row
    // that speaks for its sender; the segment alone was the misroute, and dropping the user
    // in a queue with no row selected was the reported half of it.
    expect(openTargetFor(msg({ folder: "ohmail/Screener" }), false, someRow)).toEqual({
      kind: "screener",
      segment: "waiting",
      row: "sender-row-7",
      letter: "m-1",
    });
  });

  it("an earlier letter of a waiting sender opens over the card; the card's own newest letter does not", () => {
    // The card opens on the sender's newest held letter, whose id is a derived row's own. A hit on
    // an older letter landed on the card's top with the matched letter far below, off screen.
    const rowIsNewest = (): string => "m-9";
    expect(openTargetFor(msg({ id: "m-2", folder: "INBOX" }), false, rowIsNewest, new Map([["m-2", "ohmail/Screener" as const]])))
      .toEqual({ kind: "screener", segment: "waiting", row: "m-9", letter: "m-2" });
    expect(openTargetFor(msg({ id: "m-9", folder: "ohmail/Screener" }), false, rowIsNewest))
      .toEqual({ kind: "screener", segment: "waiting", row: "m-9", letter: null });
  });

  it("the Screener's other two segments route to themselves", () => {
    expect(openTargetFor(msg({ folder: "ohmail/Screened" }), false, someRow)).toMatchObject({
      kind: "screener", segment: "screened",
    });
    expect(openTargetFor(msg({ folder: "ohmail/Quarantine" }), false, someRow)).toMatchObject({
      kind: "screener", segment: "spam",
    });
  });

  it("a sender with no row opens the READER, never a rowless queue (#116 / part B)", () => {
    // A Screener surface can only show a message through its sender row. With none held, naming
    // the queue drops the user at a list the message is not in and flashes nothing — the vanish
    // #116 fixes. So it falls to the reader, in place, the same answer History gives a pile-less
    // hit. Restore the old `{ kind: "screener", ..., row: null }` and this goes red.
    expect(openTargetFor(msg({ folder: "ohmail/Screener" }), false, noRow)).toEqual({
      kind: "reader", id: "m-1",
    });
  });

  it("under 700px the Ohbox opens the reader, because the read column is display:none", () => {
    expect(openTargetFor(msg({ folder: "INBOX" }), true, noRow)).toEqual({
      kind: "ohbox", id: "m-1", reader: true,
    });
  });
});

/**
 * PRESENTATION BEFORE PHYSICAL FOLDER — the #93 misroute.
 *
 * The consent cutline presents a message somewhere other than its folder without moving it:
 * `placeOf` is the map. `openTargetFor` must consult it FIRST, so a hit lands in the pile the
 * user actually sees it in, not the one its IMAP folder names. A `get` of `undefined` (or no map
 * at all) means the partition never placed it, and only then is the folder the answer — which is
 * why every case above, passing no map, still routes by folder.
 */
describe("the decision: presentation overrides the physical folder", () => {
  const M = "m-1";
  const place = (v: EngineMessage["folder"] | null): ReadonlyMap<string, EngineMessage["folder"] | null> =>
    new Map<string, EngineMessage["folder"] | null>([[M, v]]);

  it("an INBOX message presented in the Screener routes to the Screener, not the Ohbox", () => {
    // The reported case: sender undecided, mail physically in INBOX, presented in the waiting
    // queue. Folder-based routing dropped this at the Ohbox where its row never appears.
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, someRow, place("ohmail/Screener")),
    ).toEqual({ kind: "screener", segment: "waiting", row: "sender-row-7", letter: "m-1" });
  });

  it("an INBOX message presented in History opens the reader — History is pile-less", () => {
    expect(openTargetFor(msg({ folder: "INBOX" }), false, noRow, place(null))).toEqual({
      kind: "reader", id: M,
    });
  });

  it("a Screener-folder message DECIDED into the Ohbox routes to the Ohbox — override both ways", () => {
    // Presentation wins even when it pulls a message OUT of a Screener folder: a decided sender's
    // held mail presents in the Ohbox, and the hit must go there.
    expect(
      openTargetFor(msg({ folder: "ohmail/Screener" }), false, someRow, place("INBOX")),
    ).toEqual({ kind: "ohbox", id: M, reader: false });
  });

  it("a message the partition never placed falls back to its physical folder", () => {
    // `undefined` from the map (an empty map here) is "not considered", and the folder is then
    // the honest answer — the same path a no-map call takes.
    expect(
      openTargetFor(msg({ folder: "ohmail/News" }), false, noRow, new Map()),
    ).toEqual({ kind: "stream", view: "reads", id: M });
  });
});

/**
 * PARKED MAIL IS PILE-LESS, so the Ohbox arm may not claim it.
 *
 * A mail is in exactly one pile: once it is filed under Answer Later, Set aside or Resurface, no
 * Ohbox group lists it (`selectors.ts#parkedMessageIds`). Routing such a hit to the Ohbox is the
 * same dead end the `placeOf` block above closes — arrive, select nothing, flash nothing — reached
 * through triage state rather than through consent.
 *
 * MUTATION WATCHED: drop the `parked?.has(m.id)` arm in `openTargetFor` and the first case here
 * returns `{kind:"ohbox"}` and goes red.
 */
describe("the decision: a message parked in a bottom pile opens in the reader", () => {
  const M = "m-1";

  it("an INBOX message parked in a pile opens the reader, NOT the Ohbox", () => {
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, undefined, new Set([M])),
    ).toEqual({ kind: "reader", id: M });
  });

  it("the parked set is consulted for the NARROW layout too — no Ohbox arm either way", () => {
    // `narrow` only decides whether the Ohbox arm opens the reader beside the list. A parked
    // message never reaches that arm, so the answer must not depend on the width.
    expect(
      openTargetFor(msg({ folder: "INBOX" }), true, noRow, undefined, new Set([M])),
    ).toEqual({ kind: "reader", id: M });
  });

  it("an UNPARKED message is untouched by the parameter — the set is a filter, not a switch", () => {
    expect(
      openTargetFor(msg({ folder: "INBOX" }), false, noRow, undefined, new Set(["someone-else"])),
    ).toEqual({ kind: "ohbox", id: M, reader: false });
  });

  /**
   * THE SCOPE, PINNED. `ohboxView` is the only surface that holds parked rows out, so Reads and
   * Receipts still list them and a hit there must still be located there. Hoist the parked check
   * to the top of `openTargetFor` — which is where I first wrote it — and this goes red: a Reads
   * issue queued for Answer Later would open in a floating reader instead of its own stream.
   */
  it("parked mail in a STREAM folder still routes to its stream — piles are the Ohbox's business", () => {
    expect(
      openTargetFor(msg({ folder: "ohmail/News" }), false, noRow, undefined, new Set([M])),
    ).toEqual({ kind: "stream", view: "reads", id: M });
  });
});

describe("the arrival: the shell locates the row it navigated to", () => {
  it("every mounted Search destination receives the selected row or letter", () => {
    const search = read("../../../packages/app-logic/src/search/live-open.ts");
    expect(search).toMatch(/case "ohbox":[\s\S]*?place: "ohbox", open: target\.id/);
    expect(search).toMatch(/case "stream":[\s\S]*?"news" : "receipts", open: target\.id/);
    expect(search).toMatch(/case "screener":[\s\S]*?open: target\.letter \?\? target\.row/);
    expect(search).toMatch(/commands\.go\(there, \{ entered: true \}\)/);
    expect(read("../../../packages/app/src/ohbox/Seat.tsx")).toContain("args.entered.letter");
    expect(read("../../../packages/app-logic/src/streams/live.ts"))
      .toMatch(/useTakeEntered\(\s*entered,[\s\S]*?id === model\.openId/);
    expect(read("../../../packages/app/src/screener/ScreenerList.tsx")).toContain("view.select(row.id, null, id)");
  });

  it("the Ohbox reveals the arrived row through its own row marks", () => {
    const source = read("../../../packages/app-logic/src/ohbox/window.ts");
    expect(source).toMatch(/querySelectorAll<HTMLElement>\(input\.rowSelector\)/);
    expect(source).toMatch(/dataset\.id === selectedId/);
    expect(source).toMatch(/revealInScroller\(scroller, mounted\)/);
    expect(read("../../../packages/app/src/ohbox/OhboxGroup.tsx"))
      .toMatch(/located=\{beside\.located != null && row\.members\.some/);
  });

  it("gives up rather than looping forever", () => {
    const source = read("../../../packages/app-logic/src/ohbox/window.ts");
    const reveal = source.slice(source.indexOf("export function useRevealSelection("));
    expect(reveal).toMatch(/if \(idx < 0 \|\| rowIdx < 0\) return/);
    expect(reveal).toMatch(/\}, \[selectedId, listScrollerRef\]\);/);
    expect(reveal).not.toMatch(/requestAnimationFrame|setTimeout|setInterval/);
  });

  it("the flash is a fading wash, and reduced motion still gets the colour", () => {
    const css = read("../../../packages/ui/src/mail/Lists/row.css");
    expect(css).toMatch(/\.oh-row\[data-located\] \{\s*animation: oh-row-located/);
    expect(css).toMatch(/@keyframes oh-row-located \{\s*from \{\s*background: var\(--wash\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.oh-row\[data-located\] \{\s*animation: none;\s*background: var\(--wash\)/);
  });
});

describe("the Search arrival wash in the mounted Ohbox", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("unmarks on unmount, so leaving mid-flash cannot leave a row marked", async () => {
    const first = threadMessage("a", 30, { threadId: "a", subject: "Invoice a" });
    const second = threadMessage("b", 0, { threadId: "b", subject: "Invoice b" });
    await mountThread([first, second]);
    const fetchMail = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      /\/search\?/.test(String(input))
        ? Promise.resolve(Response.json({ items: [first.entity, second.entity], total: 2, totalExact: true, ms: 4 }))
        : fetchMail(input, init);

    await goTo("search");
    const box = screen.getByRole<HTMLInputElement>("textbox", { name: "Search" });
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(box, "invoice");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(1_000);
    await settle();
    const hit = screen.getAllByRole("listitem").find((item) => item.dataset.hit === "b")!;
    await click(within(hit).getByRole("button"), "the second hit");
    expect(window.location.hash).toBe("#/ohbox/m/b");
    expect(rowOf(document, "b")?.hasAttribute("data-located")).toBe(true);
    expect(rowOf(document, "a")?.hasAttribute("data-located")).toBe(false);

    await goTo("history");
    await goTo("ohbox/m/b");
    await settle();
    expect(rowOf(document, "b")?.hasAttribute("data-located")).toBe(false);
  });
});

describe("the locate effect, run against real rows", () => {
  afterEach(() => { document.body.innerHTML = ""; });

  function listWith(ids: string[]): void {
    const view = document.createElement("section");
    view.className = "fr-list";
    for (const id of ids) {
      const row = document.createElement("div");
      row.className = "oh-row";
      row.dataset.id = id;
      view.appendChild(row);
    }
    document.body.appendChild(view);
  }

  it("the selector finds the right row among many, and only that one", () => {
    listWith(["a", "b", "c"]);
    expect(rowOf(document, "b")?.dataset.id).toBe("b");
    expect(rowOf(document, "absent")).toBeNull();
    expect(document.querySelectorAll(".oh-row[data-located]")).toHaveLength(0);
  });

  it("an id with quotes or a slash cannot break out of the selector", () => {
    listWith(['a"b', "c/d"]);
    expect(rowOf(document, 'a"b')?.dataset.id).toBe('a"b');
    expect(rowOf(document, "c/d")?.dataset.id).toBe("c/d");
  });
});
