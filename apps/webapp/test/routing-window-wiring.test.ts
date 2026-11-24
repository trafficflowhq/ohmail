import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sliceOfDeclaration } from "./source-anchor";

const PRESENTED = "packages/app-logic/src/reading/presented-mirror.ts";
const MOUNT = "packages/app/src/mail/ground/PresentedMount.tsx";
const PRESS = "packages/app-logic/src/press/move-to-place.ts";

const fileThroughRouting = () => sliceOfDeclaration(readFileSync(PRESS, "utf8"), "fileThroughRouting");

function productSource() {
  return ["apps/webapp/app", "packages/app/src", "packages/app-logic/src"].flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .map((file) => {
        const path = `${root}/${file.replaceAll("\\", "/")}`;
        return { path, text: readFileSync(path, "utf8") };
      }),
  );
}

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
    const product = productSource();
    const mount = product.find(({ path }) => path === MOUNT)?.text ?? "";
    const presented = product.find(({ path }) => path === PRESENTED)?.text ?? "";
    expect(mount).toMatch(/const \{ held, places \} = useRoomHolds\(\)/);
    expect(mount).toMatch(/presentedOver\(reader, consentView, held, places\)/);
    expect(presented, "the composition no longer overlays a held routing press on held deletes")
      .toMatch(/presentAt\(hideMessages\([\s\S]{0,240}?, places\)/);
    const count = (needle: string, declaration?: string) => product
      .reduce((total, { path, text }) => total + text.split(needle).length - 1 - (path === declaration ? 1 : 0), 0);
    expect(count("presentAt("), "presentAt is composed more than once").toBe(1);
    expect(count("presentedOver(", PRESENTED), "the composition is called more than once").toBe(1);
  });

  it("the press opens a window rather than dispatching the routing itself", () => {
    const slice = fileThroughRouting();
    expect(slice, "the press does not open a window").toMatch(/routing\.hold\(/);
    /* AND THE HELD HALF IS NOT ALSO SENT: the mail's own dispatch is there, the rules' is not. */
    expect(slice, "the press dispatched the rules it is supposed to be holding")
      .not.toMatch(/for \(const mu of rules\) void/);
  });

  it("the offer is derived from the engine's table, never from a flag at the call site", () => {
    /* `UNDO_CLASS.routing_plan` is what says a routing press is undoable at all; the shell reads
       the window's own answer about THIS press and nothing else. A boolean argument here would be
       a second opinion that could disagree with the table. */
    const slice = fileThroughRouting();
    expect(slice).toMatch(/opened\.held/);
    expect(slice, "the press carries its own undoable flag").not.toMatch(/undoable\s*[:=]/);
  });
});
