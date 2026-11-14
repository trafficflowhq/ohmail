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

/** Each gate by the name it is declared under — `sliceOfDeclaration` refuses a stale anchor. */
const GATES: Array<{ file: string; name: string }> = [
  { file: "../app/shell/shell-verbs.ts", name: "canDeleteMessage" },
  { file: "../app/shell/shell-verbs.ts", name: "planMoveToPlace" },
  { file: "../app/shell/shell-open-state.ts", name: "verbHolds" },
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
    expect(codeOf(sliceOfDeclaration(read("../app/shell/MessagePane.tsx"), "deleteConfirmAdmitted")))
      .toMatch(/chrome\.verbHolds\?\./);
    const keys = read("../app/shell/shell-keys.tsx");
    expect(keys).toMatch(/\|\| engine\.verbRead\(\)\.get<EngineMessage>\("message", focused\.id\) == null/);
    expect(keys).toMatch(/&& engine\.verbRead\(\)\.get<EngineMessage>\("message", focused\.id\) != null/);
  });

  it("the census can see a gate on the mirror alone — its own positive control", () => {
    const mirrorOnly = "const canDeleteMessage = (m) => reader.get(\"message\", m.id) != null;\nconst next = 1;\n";
    const code = codeOf(sliceOfDeclaration(mirrorOnly, "canDeleteMessage"));
    expect(code).not.toMatch(/engine\.verbRead\(\)/);
    expect(code).toMatch(/\breader\.get\b/);
  });
});
