import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sliceOfDeclaration } from "./source-anchor";

/**
 * A HISTORY OR SEARCH ROW IS OFFERED ITS VERBS — every gate and
 * every Undo a surface reads before it presses asks `engine.verbRead()`, the reader `mutate`
 * computes its effects from, never the mirror alone: a gate on the mirror withholds Delete from a
 * row the door would act on. Read by the CALL inside each gate's own declaration, web and phone.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * Each gate by the name it is declared under — `sliceOfDeclaration` refuses a stale anchor. RE-POINTED TO THE NEW SHELL
 * (RULING-NEW-SHELL-FIRST D (3)): today's shell gates (`shell-verbs.ts` canDeleteMessage and planMoveToPlace,
 * `shell-open-state.ts` verbHolds) leave with it; a seat's verbs plan their moves in the press
 * (`press/move-to-place.ts`), and the Ohbox's cursor row asks whether its row may be deleted in its keys
 * (`ohbox/live.ts` useOhboxKeys, `d` and ⌫ at one column).
 */
const GATES: Array<{ file: string; name: string }> = [
  { file: "../../../packages/app-logic/src/press/move-to-place.ts", name: "planMoveToPlace" },
  { file: "../../../packages/app-logic/src/ohbox/live.ts", name: "useOhboxKeys" },
  { file: "../../../packages/app-logic/src/press/shell-dispatch.ts", name: "mutateAndReport" },
  { file: "../../../packages/app-logic/src/press/shell-dispatch.ts", name: "mutateSetAndReport" },
  { file: "../../../packages/app-logic/src/press/shell-dispatch.ts", name: "routing" },
  { file: "../../mobile/src/state/live.ts", name: "messageOf" },
];

/** A gate's code, its comments dropped: a docblock may name the mirror while explaining why not. */
const codeOf = (slice: string): string => slice.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

describe("every verb gate on the browser and the phone reads the verb reader", () => {
  for (const { file, name } of GATES) {
    it(`${file.replace(/^(\.\.\/)+/, "")} · ${name}`, () => {
      const code = codeOf(sliceOfDeclaration(read(file), name));
      expect(code).toMatch(/engine\.verbRead\(\)/);
      expect(code).not.toMatch(/engine\.read\(\)|\breader\.get\b/);
    });
  }

  it("the Delete strip asks the verb reader's chrome field, and the `d` and ⌫ keys the same reader", () => {
    const reader = "../../../packages/app/src/reader";
    const panel = codeOf(sliceOfDeclaration(read(`${reader}/actions/ActionBar.tsx`), "ActionBar"));
    const menus = codeOf(sliceOfDeclaration(read(`${reader}/actions/ActionMenus.tsx`), "ActionMenus"));
    const keys = read(`${reader}/keys.ts`);
    expect(panel).toMatch(/const file = \(\): void => \{\s*close\(\);\s*verbs\.act\("delete"\);/);
    expect(panel).toContain("trash={file}");
    expect(menus).toMatch(/if \(menu !== "cardDelete" \|\| !isCardDeleteKey\(e\.nativeEvent\)\) return false;\s*e\.preventDefault\(\);\s*trash\(\);/);
    expect(keys).toContain('run: () => open.menu("cardDelete")');
    expect(codeOf(sliceOfDeclaration(keys, "trashKeys"))).toContain('open.verbs.act("delete")');

    const verbs = codeOf(sliceOfDeclaration(read(`${reader}/actions/use-verbs.ts`), "useVerbs"));
    expect(verbs).toMatch(/if \(action === "delete" && host\.engine\.verbRead\(\)\.get<EngineMessage>\("message", message\.id\) == null\)\s*return;/);
    expect(verbs).toContain("visit.act(action);");
    const list = "../../../packages/app-logic/src/press";
    const listVerbs = codeOf(sliceOfDeclaration(read(`${list}/message-verbs.ts`), "runMessageAction"));
    expect(listVerbs).toMatch(/case "delete": \{\s*const current = rowOf\(cx, m\.id\);\s*if \(current === undefined\) return;/);
    expect(read(`${list}/verb-context.ts`)).toContain("withRows(cx.engine.verbRead(), cx.surfaceById)");
    expect(codeOf(sliceOfDeclaration(read(`${list}/verb-context.ts`), "rowOf")))
      .toContain('setRead(cx).get<EngineMessage>("message", id)');
  });

  it("the census can see a gate on the mirror alone — its own positive control", () => {
    const mirrorOnly = "const canDeleteMessage = (m) => reader.get(\"message\", m.id) != null;\nconst next = 1;\n";
    const code = codeOf(sliceOfDeclaration(mirrorOnly, "canDeleteMessage"));
    expect(code).not.toMatch(/engine\.verbRead\(\)/);
    expect(code).toMatch(/\breader\.get\b/);
  });
});
