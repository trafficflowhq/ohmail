import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shellFramePaths, shellSliceOf } from "./source-anchor";

/**
 * THE HELD ROUTING PRESS IS WIRED INTO THE SHELL, and this file exists because the alternative is
 * the shape this repository keeps shipping: a correct module with no caller. `presentAt` and the
 * routing window have their own cases in the engine and their own behaviour cases in
 * `routing-verb-undo.test.tsx`; these read the SOURCE, out of each declaration's own slice, so a
 * rename throws `anchor not found` rather than measuring an empty one.
 */

describe("the held press reaches the presentation", () => {

  /**
   * READ AS ONE EXPRESSION AND NOT AS A DECLARATION'S SLICE, which was the first shape and could
   * not work: `presented` names TWO things in this file — the pile reader and a row's presented
   * place inside a mapper — so the anchor resolved to whichever came first and measured a line
   * that has nothing to do with the window.
   */
  it("the presentation is built through presentAt over the window's own places", () => {
    /* Over the MANIFEST of shell frames, not one file: the projection moved to
       `shell-derivations.ts` (ARCH-022), and the once-only count is only an answer when it is
       taken over every frame the shell composes. */
    const frames = shellFramePaths(process.cwd()).map((f) => readFileSync(f, "utf8"));
    /* THE COMPOSITION IS WRITTEN ONCE, in `presentedOver` of app-logic's `reading/presented-mirror.ts`, since the
       partition was cut out for the mail ground: the frame that held it calls that one function with the window's
       own places, and the function is where `presentAt` stands over the held deletes. Both halves are asked. */
    const written = readFileSync(`${process.cwd()}/packages/app-logic/src/reading/presented-mirror.ts`, "utf8");
    expect(written, "the one composition no longer shows a held routing press over the held deletes")
      .toMatch(/presentAt\(hideMessages\([\s\S]{0,240}?, places\)/);
    const carrying = frames.filter(
      (src) => /presentedOver\([\s\S]{0,240}?routing\.places\)/.test(src));
    expect(carrying, "the presentation no longer carries a held routing press").toHaveLength(1);
    /* ONCE. A second composition somewhere else would be a second answer about where a held row
       is shown, and the two would drift. */
    const composed = [...frames, written].reduce((n, src) => n + src.split("presentAt(").length - 1, 0);
    expect(composed, "presentAt is composed more than once").toBe(1);
    const called = frames.reduce((n, src) => n + src.split("presentedOver(").length - 1, 0);
    expect(called, "the one composition is called more than once").toBe(1);
  });

  it("the press opens a window rather than dispatching the routing itself", () => {
    /* The door moved to `shell-verbs.ts` with the press half (ARCH-022); `shellSliceOf` asks
       the manifest for the frame that declares it and refuses zero hits and two. */
    const slice = shellSliceOf("fileThroughRouting");
    expect(slice, "the press does not open a window").toMatch(/routing\.hold\(/);
    /* AND THE HELD HALF IS NOT ALSO SENT: the mail's own dispatch is there, the rules' is not. */
    expect(slice, "the press dispatched the rules it is supposed to be holding")
      .not.toMatch(/for \(const mu of rules\) void/);
  });

  it("the offer is derived from the engine's table, never from a flag at the call site", () => {
    /* `UNDO_CLASS.routing_plan` is what says a routing press is undoable at all; the shell reads
       the window's own answer about THIS press and nothing else. A boolean argument here would be
       a second opinion that could disagree with the table. */
    const slice = shellSliceOf("fileThroughRouting");
    expect(slice).toMatch(/opened\.held/);
    expect(slice, "the press carries its own undoable flag").not.toMatch(/undoable\s*[:=]/);
  });
});
