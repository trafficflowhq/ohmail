/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openTargetFor, type OpenTarget } from "../app/shell/AppShell";
import type { EngineMessage } from "@ohmail/client-engine";
/* `openMessage` is read as source below, anchored on its DECLARED NAME. This file's anchor had
   already been re-spelled once when a codemod renamed the hook; the helper is what ends that. */
import { shellFrameOf, sliceOfDeclaration } from "./source-anchor.js";

/**
 * A SEARCH HIT ARRIVES SOMEWHERE VISIBLE.
 *
 * Reported as: opening a result *"brings me to the mail in the screener but does not highlight
 * / select it"*. The routing was already right — `openTargetFor` picks the pile and
 * `openMessage` sets that pile's cursor — and the ARRIVAL was silent. You were handed a list
 * with a cursor somewhere in it and no indication which row you had just asked for, which on
 * the Screener (rows are SENDERS, the queue is long) is indistinguishable from being dropped
 * at the top of a queue of strangers.
 *
 * ── WHAT IS ASSERTED, AND WHY IT IS SPLIT THIS WAY ────────────────────────────────────
 *
 * The DECISION — which pile, which cursor — is a pure function and is tested as one, per view
 * shape. The ARRIVAL is a DOM effect over a contract every view already keeps (`.row[data-id]`),
 * and is tested against that contract directly: the shell finds a row, scrolls it, marks it,
 * and unmarks it. Splitting them keeps four view-shape cases cheap and still watches the one
 * mechanism they all share.
 */

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
  /* The open and the flash that follows it are one region, and it lives in `shell-open-state.ts`
     since ARCH-022 — asked of the frame that DECLARES `openMessage` rather than of a path, so a
     later move re-aims this by itself and a second declaration of the name refuses. */
  const shell = shellFrameOf("openMessage").source;

  it("every arm of openMessage names the row it is taking you to", () => {
    /* THIS ANCHOR HAD ALREADY BEEN RE-SPELLED ONCE — `useCallback` to `useStableCallback`, after
       the render-identity codemod turned it into -1 — which is the stopgap that holds until the
       next rename. The declared name is the anchor that does not need re-spelling, and it is also
       far narrower here: a fraction of the bytes this window ran to `startFR`, most of
       which was other callbacks. All three arms below are inside `openMessage` itself. */
    const open = sliceOfDeclaration(shell, "openMessage");
    // Ohbox, stream and screener each set it. The `default` arm opens the reader over
    // wherever you are, so there is no list row to locate — deliberately absent.
    expect(open).toMatch(/setOhboxSel\(target\.id\);[\s\S]{0,200}setLocated\(target\.id\)/);
    expect(open).toMatch(/setJump\(\{ view: target\.view[\s\S]{0,120}setLocated\(target\.id\)/);
    // The Screener's is the SENDER row's id, which is what that view puts in `data-id`. It is
    // `target.row`, non-null by construction — a rowless hit is routed to the reader by
    // `openTargetFor`, so this arm never locates nothing.
    expect(open).toMatch(/setLocated\(target\.row\)/);
  });

  it("reads the row through the selector every view already keeps", () => {
    // Four views find their own cursor this way to scroll it, and the `s` binding anchors the
    // screening popover on it. This is a fifth reader of an established contract, which is
    // what lets a view added later be located without being taught anything.
    expect(shell).toMatch(/\.view \.row\[data-id="\$\{CSS\.escape\(located\)\}"\]/);
    expect(shell).toMatch(/scrollIntoView\(\{ block: "center" \}\)/);
    expect(shell).toMatch(/classList\.add\("is-located"\)/);
  });

  it("gives up rather than looping forever", () => {
    // A row that never appears is a message that has left that pile. Without the deadline the
    // rAF loop would stay alive for the life of the tab.
    expect(shell).toMatch(/const LOCATE_TIMEOUT_MS = \d+/);
    expect(shell).toMatch(/Date\.now\(\) > deadline/);
  });

  it("unmarks on unmount, so leaving mid-flash cannot leave a row marked", () => {
    const eff = shell.slice(shell.indexOf("useEffect(() => {\n    if (!located) return;"), shell.indexOf("const startFR"));
    expect(eff).toMatch(/cancelAnimationFrame\(raf\)/);
    expect(eff).toMatch(/found\?\.classList\.remove\("is-located"\)/);
  });

  it("the flash is a fading wash, and reduced motion still gets the colour", () => {
    // The information is the colour, not the movement — a reduced-motion reader must still be
    // told which row, they simply are not animated at.
    const css = read("../app/app.css");
    expect(css).toMatch(/\.row\.is-located \{\s*animation: locate-flash/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,160}\.row\.is-located/);
  });
});

/* ── the mechanism, against the contract the views keep ─────────────────────────────── */

describe("the locate effect, run against real rows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    // jsdom has no `CSS` object. The shell harness stubs it the same way; the escape is real
    // (it is what stops an id with a quote in it breaking out of the selector), so the stub
    // has to actually escape rather than pass through.
    (globalThis as unknown as { CSS?: unknown }).CSS ??= {
      escape: (v: string) => v.replace(/["\\\]]/g, (c) => `\\${c}`),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  /** The row shape all four views render. */
  function listWith(ids: string[]): HTMLElement {
    const view = document.createElement("div");
    view.className = "view";
    for (const id of ids) {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("data-id", id);
      row.scrollIntoView = vi.fn();
      view.appendChild(row);
    }
    document.body.appendChild(view);
    return view;
  }

  it("the selector finds the right row among many, and only that one", () => {
    // The contract this whole feature rests on. If a view ever stops putting the id in
    // `data-id`, this is the assertion that says so rather than the flash quietly never firing.
    listWith(["a", "b", "c"]);
    const hit = document.querySelector(`.view .row[data-id="${CSS.escape("b")}"]`);
    expect(hit).not.toBeNull();
    expect(hit!.getAttribute("data-id")).toBe("b");
    expect(document.querySelectorAll(".view .row.is-located")).toHaveLength(0);
  });

  it("an id with quotes or a slash cannot break out of the selector", () => {
    // `CSS.escape` is why this is safe. Message ids come from the server and screener row ids
    // are derived from sender addresses; neither is a literal this may interpolate raw.
    listWith(['a"b', "c/d"]);
    expect(document.querySelector(`.view .row[data-id="${CSS.escape('a"b')}"]`)).not.toBeNull();
    expect(document.querySelector(`.view .row[data-id="${CSS.escape("c/d")}"]`)).not.toBeNull();
  });
});
