import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shellFrameOf, shellSliceOf, sliceOfDeclaration } from "./source-anchor";

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
 * ── HOW TO WATCH IT FAIL ────────────────────────────────────────────────────────────────────
 *
 * Re-add `consent.foldersEnabled === true &&` to any one of the three AppShell predicates, or
 * `chrome.foldersEnabled === true &&` to `deleteConfirmAdmitted`, and exactly that site's case
 * goes red naming itself. Rename a predicate and the anchor case goes red instead of the count
 * silently passing over a region it no longer found — which is the failure a census must not
 * have.
 */

const read = (rel: string): string =>
  readFileSync(resolve(__dirname, "..", "app", "shell", rel), "utf8");

/**
 * TWO OF THE FOUR SITES ARE DECLARATIONS AND USE THE REPO'S HELPER; TWO CANNOT.
 *
 * `canDeleteMessage` and `deleteConfirmAdmitted` are `const <name> =` declarations, so they are
 * anchored with `sliceOfDeclaration`, which throws `anchor not found: <name>` rather than handing
 * back an empty slice every assertion passes over — and `anchor-census.test.ts` refuses the older
 * shape (`indexOf("const X = useStableCallback")`) across this whole directory, because a codemod
 * that re-spells the hook silently empties the window. The first version of this file anchored
 * site 1 that way and that census caught it.
 *
 * The other two are not declarations at all: they are PROPERTIES inside the shell's key-binding
 * array (`disabled:` on the `d` entry, `canDelete:` in the `deleteKeyBindings` spread), which the
 * helper has no name to find. They keep the literal-anchor form below, with the two guards that
 * make the same failure loud: the terminator must be FOUND after the anchor, and the region must
 * be implausibly short of a whole file. A missing anchor is a named failure in both shapes; what
 * is never allowed is a window that quietly becomes empty.
 */
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
  /* THE FRAME THAT HOLDS THE TWO KEY-BINDING SITES. Both are PROPERTIES inside the global key
     map, which left `AppShell.tsx` for `shell-keys.tsx` (ARCH-022 L6) — the literal anchors move
     with them, so the frame is resolved by a name in it (`noCursor`, the key map's own disabled
     reason) rather than by a path. */
  const shell = shellFrameOf("noCursor").source;
  const pane = read("MessagePane.tsx");

  /** The four sites, each named the way the report and the changelog name them. */
  const SITES: Array<{ name: string; body: string; must: string }> = [
    {
      name: "`canDeleteMessage` — the gate the split views borrow (`shell-verbs.ts`)",
      body: shellSliceOf("canDeleteMessage"),
      must: 'engine.verbRead().get<EngineMessage>("message", m.id) != null',
    },
    {
      name: "the `d` binding's `disabled` (`shell-keys.tsx`) — what the `?` sheet prints",
      body: region(shell, 'chord: "d",', "A HELD KEY IS ONE PRESS", "the d binding"),
      must: 'engine.verbRead().get<EngineMessage>("message", focused.id) == null',
    },
    {
      name: "`deleteKeyBindings`' `canDelete` (`shell-keys.tsx`) — ⌫ and ⌦",
      /* The call's own closing line, at the spread's indentation: the same end whether a comma follows it or the
         bracket of an array the spread stands in. */
      body: region(shell, "...deleteKeyBindings({", "\n    })", "deleteKeyBindings"),
      must: 'engine.verbRead().get<EngineMessage>("message", focused.id) != null',
    },
    {
      name: "MessagePane `deleteConfirmAdmitted` — the strip and the More entry",
      body: sliceOfDeclaration(pane, "deleteConfirmAdmitted"),
      must: "chrome.verbHolds?.(message.id) !== false",
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
      expect(site.body, `${site.name} no longer reads the verb reader at all`).toContain(site.must);
    });
  }

  it("the flag is still SUPPLIED to the chrome — the rail and the folder views read it", () => {
    // Dropping the term from the predicates is not dropping the foundation flag: the folders
    // rail group, the folder views and Move-to-folder are all still gated on it, and
    // `folders-rail.test.tsx` pins the shell's supply byte for byte.
    /* The `chrome` memo is the composition root's own glue and stayed in `AppShell.tsx` when the
       key map left it, so this half names that frame and the two above name the keys'. */
    expect(read("AppShell.tsx")).toContain("foldersEnabled: consent.foldersEnabled,");
    // The entity list is a whole-mirror derivation and moved to `shell-derivations.ts` (ARCH-022);
    // it is asked of whichever frame declares it, so the supply is still read and not assumed.
    expect(shellFrameOf("folders").source)
      .toMatch(/consent\.foldersEnabled \? reader\.list<FolderEntity>\("folder"\) : \[\]/);
  });
});
