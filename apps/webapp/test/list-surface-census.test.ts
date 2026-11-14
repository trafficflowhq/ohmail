import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * ═══ ONE READING, NOT SIXTEEN HAND-WRITTEN CONDITIONS ══════════════════════════════════════
 *
 * The phone renders every list through one pure function; the web had the same discipline by
 * hand per view, and the Ohbox missed — its empty sentence waited for `settled` while its count
 * spoke the moment a row landed, which is the partial count measured on the managed web. The
 * rule now lives in `@ohmail/client-engine` (`listSurface` / `countWhen` / `saysEmpty`) and this
 * census is what keeps the views on it: a view that states a mailbox fact reads it from there,
 * and a view that decides on `settled` by hand is refused by name.
 */

const VIEWS = join(__dirname, "..", "app", "views");

/**
 * The mirror lists — every view whose rows come out of the local mirror and whose emptiness is
 * therefore a claim about the account's own mail. Each one renders through the shared reading.
 */
const GUARDED: Record<string, string> = {
  "ScreenerView.tsx": "the per-segment empty state and the waiting count",
  "HistoryView.tsx": "the empty pane, the message count and the reading column, through `useListView`",
  "ReadsView.tsx": "the 'N new since you were here' count and the end-of-pile line",
  "ReceiptsView.tsx": "the same pair, on the receipts pile",
  "DraftsView.tsx": "the empty pane, through `ListEmpty`",
  "TagView.tsx": "the empty pane and the reading column, through `useListView`",
  "TriageView.tsx": "the per-pile empty pane and the reading column, through `useListView`",
  "FolderView.tsx": "the empty pane over the server's pages and the reading column, through `useListView`",
  "TrashView.tsx": "the empty pane over the server's pages and the reading column, through `useListView`",
};

/**
 * THE VIEWS ON THE LIST SURFACE (`shell/list-view.tsx`): their empty pane, their gone notice and the
 * narrow-width question come from it and from nowhere else, so each of the three is refused by hand.
 */
const ON_LIST_SURFACE = ["HistoryView.tsx", "DraftsView.tsx", "TagView.tsx", "TriageView.tsx", "FolderView.tsx", "TrashView.tsx"];

/**
 * And the views this rule does NOT reach, each with the reason — a list as load-bearing as the
 * one above, because a census that cannot say what it did not cover has covered nothing.
 */
const OUT_OF_SCOPE: Record<string, string> = {
  "AddressView.tsx": "results of an address search, not a pile — its emptiness is the query's",
  "ComposeView.tsx": "an editor; it has no list",
  "HistoryRail.tsx": "History's month rail — buttons over the store's timeline; no list, no emptiness",
  "RulesView.tsx": "rules are account rows, not mail; no mirror claim",
  "SearchView.tsx": "results of a query, with its own indexing and scope-failure states",
  "SeedReviewView.tsx": "a review screen that takes the stage; no pile",
  "SettingsView.tsx": "panes, not a list",
  "rules-standing.ts": "the Rules page's pure derivations over rules and the waiting list; no mail, no pile",
  "settings-panes.ts": "the settings tab list — one source for the nav and the palette; no mirror claim",
};

/**
 * WHAT A GUARDED VIEW MAY NOT DO. `settled` is half the question — the other half is whether
 * the account's own facts still owe this mirror mail — so a view that branches on `settled`
 * itself is deciding with one of the two and is refused. Comments are blanked first: a docblock
 * explaining the rule is not the rule being broken. Exported shape: a list of sentences, empty
 * when the file is clean.
 */
export function handGatedIn(name: string, source: string): string[] {
  const src = withoutComments(source) as string;
  const out: string[] = [];
  if (!/\b(listSurface|countWhen|saysEmpty|useListView)\s*\(/.test(src)) {
    out.push(`${name} states a mailbox fact without the shared reading`);
  }
  // `!settled` in a branch, or `settled ?` as a ternary test — the two spellings the views used.
  if (/!\s*settled\b/.test(src) || /\bsettled\s*\?/.test(src) || /&&\s*settled\b/.test(src)) {
    out.push(`${name} still decides on \`settled\` by hand`);
  }
  return out;
}

/** What a view on the list surface may not write for itself: the empty pane, the width question, the gone notice. */
export function offTheListSurface(name: string, source: string): string[] {
  const src = withoutComments(source) as string;
  const out: string[] = [];
  if (/className="empty"/.test(src)) out.push(`${name} writes its own empty pane`);
  if (/\breadColumnHidden\s*\(/.test(src)) out.push(`${name} asks the width question itself`);
  if (/<MessageGone\b/.test(src)) out.push(`${name} renders the gone notice outside ListReadColumn`);
  return out;
}

describe("every mirror list states its emptiness through one reading", () => {
  const files = readdirSync(VIEWS).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"));

  it("names every view in exactly one of the two tables", () => {
    // A new view must be classified rather than silently uncovered — the census's own
    // completeness, asked both ways so neither table can rot.
    const named = new Set([...Object.keys(GUARDED), ...Object.keys(OUT_OF_SCOPE)]);
    expect([...files].filter((f) => !named.has(f)), "a view in neither table").toEqual([]);
    expect([...named].filter((n) => !files.includes(n)), "a table row for no view").toEqual([]);
    expect(Object.keys(GUARDED).some((k) => Object.keys(OUT_OF_SCOPE).includes(k))).toBe(false);
  });

  it("refuses a guarded view that decides for itself", () => {
    const found: string[] = [];
    for (const name of Object.keys(GUARDED)) {
      found.push(...handGatedIn(name, readFileSync(join(VIEWS, name), "utf8")));
    }
    expect(found, "a view outside the shared reading").toEqual([]);
  });

  it("refuses a list-surface view that writes its empty pane, width question or gone notice itself", () => {
    const found: string[] = [];
    for (const name of ON_LIST_SURFACE) {
      expect(Object.keys(GUARDED), `${name} is on the surface but not guarded`).toContain(name);
      found.push(...offTheListSurface(name, readFileSync(join(VIEWS, name), "utf8")));
    }
    expect(found, "a list view deciding for itself").toEqual([]);
  });

  /**
   * THE POSITIVE CONTROL, both ways. Without it the case above passes for a checker that
   * returns `[]` for everything — which is exactly how a census goes green by blindness.
   */
  it("reads a hand-gated view as hand-gated, and a clean one as clean", () => {
    const handGated = `const x = !settled ? <Pending/> : <b>{t("emptyPlain")}</b>;`;
    expect(handGatedIn("Fake.tsx", handGated)).toHaveLength(2);

    const guarded = `const s = listSurface({ settled, count, pending: owed });\n`
      + `const y = saysEmpty(s) ? <b>{t("emptyPlain")}</b> : <Pending/>;`;
    expect(handGatedIn("Fake.tsx", guarded)).toEqual([]);

    // The surface's own reading counts as the reading.
    expect(handGatedIn("Fake.tsx", `return useListView({ rows, settled, picked });`)).toEqual([]);
    // Each of the three list-surface refusals fires on its own spelling, and a clean view reads clean.
    expect(offTheListSurface("Fake.tsx", `<div className="empty">x</div>`)).toHaveLength(1);
    expect(offTheListSurface("Fake.tsx", `if (readColumnHidden()) onOpen(m);`)).toHaveLength(1);
    expect(offTheListSurface("Fake.tsx", `<MessageGone openTrash={null} />`)).toHaveLength(1);
    expect(offTheListSurface("Fake.tsx", `<ListEmpty list={list} glyph="x" /><ListReadColumn list={list} regionLabel="r">{(m) => m}</ListReadColumn>`)).toEqual([]);
    // And a COMMENT naming the old spelling is not a violation — the blanking pass is why.
    const commented = `/* was: !settled && all.length === 0 */\n`
      + `const y = saysEmpty(listSurface({ settled, count })) ? null : null;`;
    expect(handGatedIn("Fake.tsx", commented)).toEqual([]);
  });
});
