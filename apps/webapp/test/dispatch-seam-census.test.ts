import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
/* The one-pass scanner — blanking comments and literals rather than matching text, so the line
   in `screener-state.ts` that QUOTES `void engine.mutate(…)` inside a comment is not a hit. */
import * as scan from "../../../scripts/lib/source-scan.mjs";
/* The declaration's own slice, by NAME. `anchor-census.test.ts` refuses a literal that names a
   declaration by the hook it is declared with, and correctly: such a literal goes green against
   an EMPTY slice the moment the declaration is reworded. This throws `anchor not found`. */
import { sliceOfDeclaration } from "./source-anchor";

/**
 * ═══ THE SHELL'S ACTION HANDLERS DISPATCH THROUGH THE SEAM, AND NOTHING ELSE ════════════════
 *
 * A press reported from anything other than its answer is the standing defect this census
 * exists to keep closed: `void engine.mutate(…)` throws the verdict away, so the success
 * sentence stands over mail the service refused and the engine rolled back. Every press the
 * shell's action handlers make now goes through `mutateAndReport` / `mutateSetAndReport`.
 *
 * TWO PINS, BOTH ONE-WAY:
 *  1. ZERO bare dispatches inside the shell's own action handlers, each named and sliced by its
 *     own declaration — a renamed handler throws `anchor not found` rather than quietly
 *     measuring an empty slice.
 *  2. The REMAINDER, per file, each with a reason. Equality rather than a ceiling: a lane that
 *     takes one of these through the seam lowers the pin in the same commit, and one that adds a
 *     bare dispatch is refused by name.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "..", "app");
/** The behaviour moved out of the shell, the press path with it: read with it, keyed `app-logic/…`. */
const LOGIC = join(HERE, "..", "..", "..", "packages", "app-logic", "src");
/** The letter's body, moved out of the web app: read with it, keyed `letter-body/…`. */
const BODY = join(HERE, "..", "..", "..", "packages", "letter-body", "src");
/* The views of the new tree: a feature presses through the frame's one seam, never the engine. */
const VIEWS = join(HERE, "..", "..", "..", "packages", "app", "src");
const NEEDLE = "void engine.mutate(";

/**
 * The bare dispatches that remain, and why each is not this census's subject. None of them raises
 * a success sentence over a verdict it discarded, which is the property the seam defends.
 */
const REMAINDER: ReadonlyArray<readonly [string, number, string]> = [
  ["app-logic/screener/screener-state.ts", 4,
   "three watched decisions and the seen-only follow-up for mail already filed"],
  ["app-logic/writing/mail-send.ts", 1,
   "a settled reply's one after-effect — clearing the answered message's Answer Later. Nothing is "
   + "claimed about it: the sentence the person reads is the send's own"],
  ["app-logic/writing/shell-compose.ts", 3,
   "the discarded reply seed and two watched scheduled-send cancellations"],
  ["shell/folder-verbs.ts", 1,
   "the folder-op notice's dismissal: it raises no sentence at all, and its three siblings in the "
   + "same object already speak only on `rolled_back`"],
  ["app-logic/writing/draft-creates.ts", 1,
   "the copy a landed create left beside its editor's row, or of a message a Discard or confirmed send "
   + "ended; no sentence rides it; a refused delete leaves one more draft, never a lost one"],
  ["views/ComposeView.tsx", 1,
   "`draft_accept` beside taking a draft into the form — the form filling IS the confirmation"],
];

/**
 * Each former bare dispatch is still accounted for. These four moved to producers that read their result.
 * The total stays pinned apart from the counts of calls still using the old shape.
 */
const REPORTED = [
  {
    file: "screener/screener-state.ts", declaration: "dispatchDecision",
    steps: [
      /dispatchScreeningChange\(plan, \[\.\.\.cardMoves, \.\.\.seedMoves\], async \(m\) =>/,
      /const r = await engine\.mutate\(over \? outrankCoveringDomains\(over, m\) : m\)/,
      /if \(r\.status === "rolled_back"/,
    ],
  },
  {
    file: "writing/shell-compose.ts", declaration: "resolveHeldSend",
    steps: [/if \(shown\) void answerHeldDraft\(shown, outcome\)/],
  },
  {
    file: "writing/shell-compose.ts", declaration: "sendAgain",
    steps: [/void answerHeldDraft\(d, "not_arrived", true\)/],
  },
  {
    file: "writing/shell-compose.ts", declaration: "discardDraftRow",
    steps: [
      /const res = await engine\.mutate\(\{ kind: "draft_discard", draftId, \.\.\.version \}/,
      /res\.status === "rolled_back" && res\.error\?\.code === "send_recorded"/,
      /return pressVerdict\(res\)/,
    ],
  },
] as const;
const REMAINDER_TOTAL = 15;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every bare dispatch in a file, by 1-based line, over source with comments and strings blanked. */
function bareIn(text: string): number[] {
  const blanked = scan.withoutCommentsAndLiterals(text);
  const at: number[] = [];
  for (let i = blanked.indexOf(NEEDLE); i >= 0; i = blanked.indexOf(NEEDLE, i + 1)) {
    at.push(scan.lineOf(blanked, i));
  }
  return at;
}

describe("the shell's dispatch seam", () => {
  /**
   * The handlers a press reaches the engine through, named one by one. `moveToPlace` and
   * `planMoveToPlace` are here too: they dispatch through `dispatchScreeningChange`, which awaits
   * its own outcome, and a bare dispatch appearing in them would be the same defect.
   *
   * The frame mounts these handlers: a seat's press reaches the engine through the
   * verbs of `packages/app-logic/src/press/` (`useListVerbs` and the functions of `VerbContext` it calls) and the
   * reader's `markSeenOver`; today's shell frames leave with it. `markSeen` is `markSeenOver` there, and the list
   * verbs' three handlers hand their work to `runMessageAction`, `runBulkAction` and `screenBulk`, read here too.
   */
  const HANDLERS = [
    "markSeenOver", "toggleTag", "bulkToggleTag", "renameTag", "deleteTag", "planMoveToPlace", "moveToPlace", "onMessageAction",
    "onBulkAction", "onBulkScreen", "runMessageAction", "runBulkAction", "screenBulk",
  ] as const;
  /**
   * TODAY's TAG VERBS THAT THE NEW TREE DOES NOT HAVE YET: creating a tag from the rail and recolouring one
   * in the Tags pane. The mount that writes one writes it in the press
   * folder and moves its name into HANDLERS: the case below refuses one that stands there unread.
   */
  const NOT_IN_THE_NEW_TREE_YET = ["createTag", "createTagAlone", "recolorTag"] as const;
  const REPO_ROOT = join(HERE, "..", "..", "..");
  const PRESS_FILES = [
    ...tsFiles(join(LOGIC, "press")),
    join(LOGIC, "reader", "mark-seen.ts"),
  ];
  /** WHICH FILE OF THE NEW PRESS DECLARES `name`: zero hits and two are both refusals, as the manifest's were. */
  function pressFrameOf(name: string): { path: string; source: string } {
    const hits = PRESS_FILES.map((path) => ({ path, source: readFileSync(path, "utf8") }))
      .filter(({ source }) => source.includes(`const ${name} =`) || source.includes(`function ${name}(`));
    if (hits.length === 0) throw new Error(`anchor not found: ${name} in the press of the new shell`);
    if (hits.length > 1) {
      throw new Error(`anchor is ambiguous: ${name} is declared in ${hits.map((h) => relative(REPO_ROOT, h.path)).join(" and ")}`);
    }
    return hits[0]!;
  }

  it("has no bare `void engine.mutate(` in the shell's action handlers", () => {
    const written = NOT_IN_THE_NEW_TREE_YET.filter((name) =>
      PRESS_FILES.some((path) => {
        const source = readFileSync(path, "utf8");
        return source.includes(`const ${name} =`) || source.includes(`function ${name}(`);
      }));
    expect(written, "a tag verb now stands in the press: move its name into HANDLERS").toEqual([]);
    const offenders: string[] = [];
    for (const name of HANDLERS) {
      /* THE FILE THAT DECLARES IT, by name across the press: `pressFrameOf` refuses both zero hits and two — a
         handler read off the wrong file is the defect, not a pass. THROWS when a handler is renamed rather than
         measuring nothing — the whole reason this is a slice by name and not an index into the file. */
      const blanked = scan.withoutCommentsAndLiterals(pressFrameOf(name).source);
      const slice = sliceOfDeclaration(blanked, name);
      const hits = slice.split(NEEDLE).length - 1;
      if (hits > 0) offenders.push(`${name}: ${hits}`);
    }
    expect(offenders, "a press in the shell's action handlers throws its verdict away again")
      .toEqual([]);
  });

  it("pins the remainder, one reason each, and refuses a new bare dispatch", () => {
    const counted = new Map<string, number>();
    for (const [root, prefix] of [[APP, ""], [LOGIC, "app-logic/"], [BODY, "letter-body/"], [VIEWS, "app/"]] as const) for (const file of tsFiles(root)) {
      const hits = bareIn(readFileSync(file, "utf8"));
      if (hits.length > 0) counted.set(prefix + relative(root, file).split("\\").join("/"), hits.length);
    }
    const pinned = new Map(REMAINDER.map(([rel, n]) => [rel, n] as const));
    const unpinned = [...counted.keys()].filter((rel) => !pinned.has(rel));
    expect(unpinned, "a NEW bare `void engine.mutate(` — take it through the seam, or pin it here "
      + "with the reason its verdict may be discarded").toEqual([]);
    const moved = [...pinned.entries()]
      .filter(([rel, n]) => (counted.get(rel) ?? 0) !== n)
      .map(([rel, n]) => `${rel}: pinned ${n}, found ${counted.get(rel) ?? 0}`);
    expect(moved, "the count moved: a dispatch taken through the seam lowers its pin in the same "
      + "commit, and a new one is refused above").toEqual([]);
    const read = (file: string, declaration: string) =>
      scan.withoutComments(sliceOfDeclaration(readFileSync(join(LOGIC, file), "utf8"), declaration));
    for (const row of REPORTED) {
      const code = read(row.file, row.declaration);
      for (const step of row.steps) expect(code, row.declaration).toMatch(step);
    }
    const answer = read("writing/shell-compose.ts", "answerHeldDraft");
    expect(answer).toMatch(/const res = await engine\.mutate\(\{ kind: "draft_resolve", draftId, outcome,/);
    expect(answer).toMatch(/if \(res\.status !== "confirmed"\)/);
    expect(answer).toMatch(/if \(stillCurrent\(\)\) openDraft/);
    expect(REMAINDER.reduce<number>((n, [, count]) => n + count, REPORTED.length),
      "every original dispatch still has a pinned source or a watched outcome").toBe(REMAINDER_TOTAL);
  });

  /** A second caller would install a second Undo window and replay the same durable intents. */
  it("calls the press seam in the frame's room and nowhere else", () => {
    const REPO = join(HERE, "..", "..", "..");
    const roots = [APP, LOGIC, BODY, VIEWS, join(REPO, "apps", "desktop", "src"), join(REPO, "apps", "paired-page", "src")];
    const callers = new Set<string>();
    for (const root of roots) for (const file of tsFiles(root)) {
      const blanked = scan.withoutCommentsAndLiterals(readFileSync(file, "utf8"));
      for (const hit of blanked.matchAll(/\buseShellDispatch\s*\(/g)) {
        if (/\bfunction\s+$/.test(blanked.slice(Math.max(0, hit.index - 20), hit.index))) continue;
        callers.add(relative(REPO, file).split("\\").join("/"));
      }
    }
    expect([...callers].sort(), "a press seam called outside the frame's room")
      .toEqual(["packages/app/src/frame/room.tsx"]);
  });
});
