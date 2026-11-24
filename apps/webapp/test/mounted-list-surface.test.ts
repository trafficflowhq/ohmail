import { readFileSync } from "node:fs";
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

const PACKAGES = join(__dirname, "../../../packages");
const read = (path: string): string => readFileSync(join(PACKAGES, path), "utf8");

const models = {
  ohbox: "app-logic/src/ohbox/groups.ts",
  screener: "app-logic/src/screener/empty.ts",
  history: "app-logic/src/history/model.ts",
  news: "app-logic/src/streams/use-stream.ts",
  receipts: "app-logic/src/streams/use-stream.ts",
  drafts: "app-logic/src/drafts/model.ts",
  tags: "app-logic/src/tags/model.ts",
  later: "app-logic/src/piles/use-piles.ts",
  parked: "app-logic/src/piles/use-piles.ts",
  resurface: "app-logic/src/piles/use-piles.ts",
  folder: "app-logic/src/folder/model.ts",
  trash: "app-logic/src/trash/model.ts",
};

const columns: Partial<Record<keyof typeof models, string>> = {
  history: "app/src/history/HistoryList.tsx",
  drafts: "app/src/drafts/DraftsList.tsx",
  tags: "app/src/tags/TagsList.tsx",
  later: "app/src/piles/PilesList.tsx",
  parked: "app/src/piles/PilesList.tsx",
  resurface: "app/src/piles/PilesList.tsx",
  folder: "app/src/folder/FolderList.tsx",
  trash: "app/src/trash/TrashList.tsx",
};

const OUT_OF_SCOPE = {
  address: "results of a contact query",
  search: "results of a search query",
  write: "the editor",
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
  it("names every view in exactly one of the two tables", () => {
    const registry = withoutComments(read("app/src/mail/places.ts")) as string;
    const block = /^const SEATED: MailPlaces = \{([\s\S]*?)^\};/m.exec(registry);
    expect(block, "the registered mail places").not.toBeNull();
    const files = [...block![1]!.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]!);
    const guarded = Object.keys(models);
    const excluded = Object.keys(OUT_OF_SCOPE);
    const named = new Set([...guarded, ...excluded]);
    expect(files.filter((id) => !named.has(id)), "a place in neither table").toEqual([]);
    expect([...named].filter((id) => !files.includes(id)), "a table row for no place").toEqual([]);
    expect(guarded.some((id) => excluded.includes(id))).toBe(false);
  });

  it("refuses a guarded view that decides for itself", () => {
    const found = [...new Set(Object.values(models))].flatMap((path) => handGatedIn(path, read(path)));
    expect(found, "a model outside the shared reading").toEqual([]);
  });

  it("refuses a list-surface view that writes its empty pane, width question or gone notice itself", () => {
    const found = [...new Set(Object.values(columns))].flatMap((path) => offTheListSurface(path, read(path)));
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
