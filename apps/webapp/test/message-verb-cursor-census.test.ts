import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY MESSAGE VERB IN THE TREE ANSWERS FOR ITS OWN SILENCE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `cursorless-first-press.test.tsx` proves the rule on the Ohbox: a message verb pressed on a list
 * with rows and no cursor PLACES the cursor and says so. That rule is declared per binding — the
 * dispatcher acts on `disabledReason: "no_cursor"` and asks a host to place — and message chords
 * are declared in nine files, six of them views wiring `useKeyBindings` themselves. A view that
 * declares its own and says nothing about the reason keeps the old behaviour with nothing on
 * screen saying so, which is the same silence one level down; a view that declares the reason and
 * has no host to answer it is the same silence one level further.
 *
 * So this file asks both questions of the whole tree, by CONTENT and not by directory:
 *
 *   1. every file declaring a `group: "message"` binding either names the reason or is EXEMPT here
 *      with a sentence saying why its verbs cannot rest for want of a cursor;
 *   2. every file that names the reason has a host that places — itself, or one named here.
 *
 * A new view cannot then arrive inert: it lands in neither table and this goes red.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────────
 *
 *   · add a `group: "message"` binding to any other file under `app/` → case 1 reds, naming it;
 *   · drop an entry from `EXEMPT` or `PLACED_BY` → the matching case reds (the tables are pinned
 *     both ways, so a stale entry reds as loudly as a missing one);
 *   · drop `useRowCursorPlacer` from `message-verbs.ts` → case 2 reds;
 *   · spell the hint a second time anywhere → the one-producer case reds.
 *
 * RE-POINTED BY PATH (share ohbox-1, the switch's older tests; ruling D (3)): the census read today's shell and views
 * (`apps/webapp/app/`), which leave with the switch; the files that now declare the message verbs and place the cursor
 * are the new parts' (`packages/app/src/`, beside `packages/app-logic/src/` and `packages/letter-body/src/` as before).
 * Its two tables name those files (the composer's chords are `write/keys.ts` now; the Ohbox's placer, which answers
 * for its own keys, its cursor row's verbs and the reader's verbs beside it, is `ohbox/live.ts`'s `useOhboxPlacer`; the
 * shared placement sentence lives with the key registry). Every expectation is as it stood. No file of the web's own that stays
 * declares a message verb (`apps/webapp/app/` holds none after the switch's deletions).
 */

const APP = new URL("../../../packages/app/src/", import.meta.url).pathname;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

const files = [...sources(APP), ...sources(new URL("../../../packages/app-logic/src/", import.meta.url).pathname), ...sources(new URL("../../../packages/letter-body/src/", import.meta.url).pathname)];
const read = (p: string): string => readFileSync(p, "utf8");
const name = (p: string): string => relative(APP, p);

/** Files holding at least one `group: "message"` declaration, by content. */
const declaring = files.filter((p) => /group:\s*"message"/.test(read(p))).map(name);
/** …and the ones that additionally state the reason the dispatcher acts on. */
const naming = declaring.filter((n) => /disabledReason:\s*"no_cursor"/.test(read(join(APP, n))));

/**
 * WHY THESE VERBS CANNOT REST FOR WANT OF A CURSOR. A sentence per file, because the point of the
 * exemption is that somebody had to be able to write one — "it does not apply here" is the claim
 * under test, not a note about it.
 */
const EXEMPT: Record<string, string> = {
  "place-list/use-row-selection.ts": "Escape clears the rows picked in a list; the binding exists only while at least one row is picked, and it acts on the picks, never on a cursor row",
  "write/keys.ts":
    "the composer's own send and schedule chords — a writing surface with no list and no cursor; "
    + "the digits are the picker's, and are declared `inWriting` for that reason",
  "../../app-logic/src/search/keys.ts":
    "`Enter` opens the hit under this view's OWN cursor, which exists whenever there are hits "
    + "(`cursor = shown.length === 0 ? -1 : min(at, …)`); it rests on an empty result set or on "
    + "focus being outside the list, neither of which a placement would answer",
  "piles/PilesAbove.tsx":
    "Reply Run opens Answer Later with its queue, regardless of the cursor in the current place.",
  "piles/PilesList.tsx":
    "Reply Run starts from the eligible Answer Later queue, regardless of which row has the cursor.",
  "stream/StreamColumn.tsx":
    "Escape collapses the addressed reading card on the phone; the binding exists only while that card is open.",
  "trash/keys.ts":
    "Restore runs for the open deleted letter alone; placing a cursor cannot select a restore target.",
  "../../app-logic/src/trash/live.ts":
    "Trash documents that erasing or moving a deleted letter is unavailable even with a cursor."
};

/**
 * WHO PLACES FOR EACH FILE THAT NAMES THE REASON. The Ohbox's seat claims the placer at `view` scope
 * (`useOhboxPlacer`, `ohbox/live.ts`): it answers for the list's own keys, for the cursor row's verbs
 * where one column stands, and for the reader's verbs beside the list. Naming the ANSWERING file is
 * what keeps the check from passing on a frame that no longer claims anything.
 */
const PLACED_BY: Record<string, string> = {
  "../../app-logic/src/press/delete-undo.ts":
    "its caller — a factory with no cursor of its own, mounted by the place whose verbs it builds",
  "../../app-logic/src/ohbox/keys.ts": "../../app-logic/src/ohbox/live.ts",
  "../../app-logic/src/ohbox/cursor-verbs.ts": "../../app-logic/src/ohbox/live.ts",
  "reader/keys.ts": "../../app-logic/src/ohbox/live.ts",
  "mail/ground/MailKeys.tsx": "../../app-logic/src/ohbox/live.ts",
  "../../app-logic/src/place-list/walk.ts": "../../app-logic/src/place-list/walk.ts",
};

const claimsAPlacer = (n: string): boolean =>
  /use(Row)?CursorPlacer\(/.test(read(join(APP, n)));

describe("every message verb is classified", () => {
  it("names the reason, or is exempt with a sentence — no third answer", () => {
    /* The fixture proves itself first: a census over nothing passes for anything. */
    expect(declaring.length, "no `group: \"message\"` declaration was found at all").toBeGreaterThan(5);
    const unclassified = declaring.filter((n) => !naming.includes(n) && !(n in EXEMPT));
    expect(unclassified, "a message verb neither names `no_cursor` nor is exempt here").toEqual([]);
  });

  it("and the exemption table is pinned both ways — a stale entry reds too", () => {
    const stale = Object.keys(EXEMPT).filter((n) => !declaring.includes(n) || naming.includes(n));
    expect(stale, "an exemption for a file that no longer needs one").toEqual([]);
    for (const [n, why] of Object.entries(EXEMPT)) {
      expect(why.length, `${n}'s exemption says nothing`).toBeGreaterThan(40);
    }
  });
});

describe("every declared reason has a host that answers it", () => {
  it("each file naming `no_cursor` is placed for, by itself or by one named here", () => {
    expect(Object.keys(PLACED_BY).sort()).toEqual([...naming].sort());
  });

  it("…and a host named as a file really does claim a placer", () => {
    const hosts = [...new Set(Object.values(PLACED_BY))].filter((v) => /\.tsx?$/.test(v));
    expect(hosts.length, "no file-named host to check").toBeGreaterThan(0);
    for (const hostFile of hosts) {
      expect(claimsAPlacer(hostFile), `${hostFile} is named as a placer and claims none`).toBe(true);
    }
    for (const n of ["../../app-logic/src/ohbox/live.ts"]) {
      expect(claimsAPlacer(n), `${n} places for the shell and claims none`).toBe(true);
    }
  });
});

describe("one placement, not one per host", () => {
  it("the hint has exactly one producer in the app", () => {
    /* Three hosts each spelling "first row, scroll it into view, say which verb is next" is how
       three lists come to place a cursor three different ways. The sentence is the tell: the
       catalogue's `cursor.placed`, read off the `cursor` words. */
    const producers = files.filter((p) => /cursor\("placed"/.test(read(p))).map(name);
    expect(producers).toEqual(["../../app-logic/src/keys/keymap.ts"]);
    expect(read(join(APP, "../../app-logic/src/ohbox/live.ts"))).toContain("cursorPlacementText(own.cursor, label)");
    expect(read(join(APP, "place-list/own.ts"))).toContain("cursorPlacementText(cursor, label)");
  });

  it("and one spelling of the placement itself", () => {
    /* The placement: a placer a place defines (the key map's own registry, `useCursorPlacer`, is the door it
       claims, not a placement). */
    const definers = files.filter((p) => /function (?!use(Row)?CursorPlacer\b)\w*Placer\(/.test(read(p))).map(name);
    expect(definers).toEqual(["../../app-logic/src/ohbox/live.ts"]);
  });
});
