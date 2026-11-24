import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sliceOfDeclaration } from "./source-anchor";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE VERB, ONE ADMISSION — "Use folders" is a term in NONE of the delete predicates
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Delete is a MOVE to the mail server's own \Trash — a system folder every account already has,
 * discovered at connect beside \Junk — never to a folder somebody made. So the USER-folders
 * foundation flag was never a fact about whether the verb can run, and the engine's
 * `message_delete` has never read it. The verb over a SELECTION never read it either.
 *
 * The cursor verb read it in FOUR places, and that is why this file counts rather than reads:
 * the four are one edit, and a fix that lands in three of them is a coherent program that
 * compiles, passes every behavioural test that happens to drive the other three, and leaves the
 * `?` sheet advertising a delete one door refuses — which is the exact asymmetry the four-site
 * fix removed. Measured live on a folders-off account before the fix: a picked row deleted with
 * a "Moved to Trash." toast and a `DELETE /messages/:id` on the wire, while the row under the
 * cursor produced nothing at all — no toast, no refusal sentence, no request — and the `?` sheet
 * drew both `d` and `⌫·⌦` greyed.
 *
 * ── WHY A SOURCE CENSUS AND NOT FOUR MORE BEHAVIOURAL CASES ─────────────────────────────────
 *
 * There ARE behavioural cases, and they are the primary evidence: `delete-key-shell.test.tsx`
 * presses ⌫ on a folders-off shell, `action-bar.test.ts` opens the strip with no flag on the
 * chrome, `split-view-keys.test.tsx` presses `d` in a split view with the consent answering off.
 * What none of them can see is a FIFTH site appearing later — a new door, or a re-added term
 * behind a branch no fixture takes. This file is the one that fails then.
 *
 * The mounted Ohbox separates the cursor's eligibility from the two key branches that consume it.
 * The reader's More menu sends its confirmation to the same Delete action and press-time refusal.
 * Each region is bounded by a named declaration or the syntax of the actual registration.
 */

const read = (rel: string): string =>
  readFileSync(resolve(__dirname, "../../..", rel), "utf8");

function region(src: string, startAt: string, endAt: string, name: string): string {
  const i = src.indexOf(startAt);
  expect(i, `${name}: anchor ${JSON.stringify(startAt)} not found — the predicate was renamed`)
    .toBeGreaterThan(-1);
  const j = src.indexOf(endAt, i);
  expect(j, `${name}: terminator ${JSON.stringify(endAt)} not found after the anchor`)
    .toBeGreaterThan(i);
  const out = src.slice(i, j);
  // A region long enough to be a whole file is a lost terminator wearing a passing result.
  expect(out.length, `${name}: region implausibly long (${out.length}) — terminator drifted`)
    .toBeLessThan(1200);
  return out;
}

describe("the delete admission reads the verb reader, and nothing about Use folders", () => {
  const logic = (file: string) => read(`packages/app-logic/src/${file}`);
  const reader = (file: string) => read(`packages/app/src/reader/${file}`);
  const cursor = sliceOfDeclaration(logic("ohbox/cursor-verbs.ts"), "cursorRowKeys");
  const menu = sliceOfDeclaration(reader("actions/ActionMenus.tsx"), "ActionMenus");
  const panel = sliceOfDeclaration(reader("actions/ActionBar.tsx"), "file");
  const runner = sliceOfDeclaration(logic("reader/verbs.ts"), "runOwnVerb");
  const tray = sliceOfDeclaration(logic("press/shell-dispatch.ts"), "deleting");

  const SITES: Array<{ name: string; body: string; must: string[] }> = [
    {
      name: "the Ohbox cursor asks the verb reader whether the message still stands",
      body: sliceOfDeclaration(logic("ohbox/live.ts"), "useOhboxKeys"),
      must: ['selected !== null && engine.verbRead().get<EngineMessage>("message", selected.id) != null'],
    },
    {
      name: "the d binding uses the cursor's admission for the confirmation and the shortcut sheet",
      body: region(cursor, 'verb("d",', "...deleteKeyBindings", "the d binding"),
      must: ['if (row !== null && deletable) ask("delete", row)', 'row !== null && !deletable ? { disabled: true }'],
    },
    {
      name: "the Backspace and Delete bindings check the same cursor admission",
      body: region(cursor, "...deleteKeyBindings({", "\n    }),", "deleteKeyBindings"),
      must: ['canDelete: row !== null && deletable', 'run: (m) => act("delete", m)'],
    },
    {
      name: "the reader's More entry and confirmation send Delete through the mailbox refusal",
      body: [menu, panel, runner, tray].join("\n"),
      must: [
        'onPress={confirm ? () => setMenu("confirmDelete") : trash}',
        'confirm={{ label: words.move, onPress: trash, keyHint: "↵" }}',
        'verbs.act("delete")',
        'return press.deleting.remove({ id: m.id, mailboxId: m.mailboxId })',
        'refusal: (mailboxIds) => readerMoveRefusal(',
        'mailboxIds.map((id) => id ?? "")',
      ],
    },
  ];

  it("names FOUR sites — a fifth door added later fails here, not in production", () => {
    expect(SITES).toHaveLength(4);
  });

  for (const site of SITES) {
    it(`${site.name} does not mention foldersEnabled`, () => {
      /* CODE LINES ONLY. `sliceOfDeclaration` returns the declaration WITH its docblock, and both
         docblocks explain at length why the flag is not a term — so a raw match over the slice
         would fire on the sentence saying the term is gone. Comment lines are dropped and the
         rest is judged; a term inside a string literal would still be caught, which is correct
         (there is no legitimate reason for one here). */
      const code = site.body
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .join("\n");
      expect(
        code,
        `"Use folders" is back in ${site.name} — the cursor delete is gated again while the `
          + "selection delete is not, which is the asymmetry this fix removed",
      ).not.toMatch(/foldersEnabled/);
    });

    it(`${site.name} still asks the verb reader — the gate that remains`, () => {
      // The positive half: a census that only forbids a term passes for a predicate that was
      // deleted outright, which would ADMIT a delete on a row neither the mirror nor a page holds.
      for (const guard of site.must) expect(site.body, `${site.name} lost its admission path`).toContain(guard);
    });
  }

  it("the flag is still SUPPLIED to the chrome — the rail and the folder views read it", () => {
    const folders = sliceOfDeclaration(logic("folder/live.ts"), "useFolders");
    expect(folders).toContain("const { foldersEnabled } = useConsent()");
    expect(folders).toMatch(/foldersEnabled \? atStamp\(derived, engine\.read\(\)\.list<FolderEntity>\("folder"\)\) : NO_FOLDERS/);
  });
});
