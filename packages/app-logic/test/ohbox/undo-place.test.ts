/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActedMarker } from "../../src/press/after-verb.js";
import type { UndoLink } from "../../src/press/index.js";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * UNDO PUTS A ROW BACK WHERE IT STOOD. A verb that takes the open row from under the cursor keeps its record;
 * Undo asks for it before the reversal goes out, and puts the cursor and the hold back only when that reversal
 * took. Moving on spends the record, and an Undo of the row moved on from says so once.
 */

let ohbox: Harness | null = null;
beforeEach(() => {
  wide();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date(at(12)));
});
afterEach(async () => {
  await ohbox?.unmount();
  ohbox = null;
  vi.useRealTimers();
});

const a = () => msg({ id: "a", date: at(10) });
const b = () => msg({ id: "b", date: at(9) });
const c = () => msg({ id: "c", date: at(8) });

/** The open row `a`, taken by a verb: the list loses it and the shell's marker names it. */
async function verbTakesA(): Promise<{ link: { current: UndoLink | null }; restored: string[] }> {
  const link: { current: UndoLink | null } = { current: null };
  const lastActed: { current: ActedMarker | null } = { current: null };
  const restored: string[] = [];
  ohbox = await mount({
    newForYou: [a(), b(), c()],
    undoLink: link,
    lastActed,
    onRestoreHold: (id) => {
      restored.push(id);
      return true;
    },
  });
  await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
  lastActed.current = { id: "a", at: Date.now() } as ActedMarker;
  await ohbox.publish({ newForYou: [b(), c()], selectedId: null });
  return { link, restored };
}

describe("Undo's place", () => {
  it("ask re-takes the hold, and settle puts the cursor back on the row when the reversal took", async () => {
    const { link, restored } = await verbTakesA();
    expect(ohbox!.calls.selected.at(-1)).toBe("b");
    let asked: string | null = null;
    await ohbox!.run(() => {
      asked = link.current!.ask(["a"]);
    });
    expect(asked).toBe("a");
    expect(restored).toEqual(["a"]);
    await ohbox!.publish({ newForYou: [a(), b(), c()] });
    await ohbox!.run(() => link.current!.settle("a", true));
    expect(ohbox!.calls.selected.at(-1)).toBe("a");
    expect(ohbox!.calls.held.at(-1)).toBe("a");
    expect(ohbox!.model.groupedNew.map((r) => r.openTarget.id)).toEqual(["a", "b", "c"]);
    expect(ohbox!.model.selected?.id).toBe("a");
  });

  it("a reversal that did not take lets the hold go and moves nothing", async () => {
    const { link } = await verbTakesA();
    await ohbox!.run(() => {
      link.current!.ask(["a"]);
    });
    const before = ohbox!.calls.selected.length;
    await ohbox!.run(() => link.current!.settle("a", false));
    expect(ohbox!.calls.selected.length).toBe(before);
    expect(ohbox!.calls.held.at(-1)).toBe(null);
  });

  it("moving on spends the record, and the row moved on from answers once", async () => {
    const { link } = await verbTakesA();
    await ohbox!.run(() => ohbox!.model.stepDown.run());
    let asked: string | null = "unset";
    await ohbox!.run(() => {
      asked = link.current!.ask(["a"]);
    });
    expect(asked).toBe(null);
    expect(link.current!.left(["a"])).toBe(true);
    expect(link.current!.left(["a"])).toBe(false);
  });
});
