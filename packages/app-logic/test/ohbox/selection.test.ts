/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * A PICK IS A PICK OF ROWS, BY ID. It survives a publish of the engine, leaves with its row, takes every letter of
 * a folded row, outlives a verb that was refused, and the row being read keeps its place while it lives.
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

const rows = () => [
  msg({ id: "a", date: at(10) }),
  msg({ id: "b", date: at(9) }),
  msg({ id: "c", date: at(8) }),
];

describe("the selection", () => {
  it("survives a publish of new arrays for the same letters", async () => {
    ohbox = await mount({ newForYou: rows() });
    await ohbox.run(() => {
      ohbox!.model.togglePick("a");
    });
    await ohbox.run(() => {
      ohbox!.model.togglePick("c");
    });
    await ohbox.publish({ newForYou: [msg({ id: "z", date: at(11) }), ...rows()] });
    expect(ohbox.model.pickedIds).toEqual(["a", "c"]);
    expect(ohbox.model.pickedRowCount).toBe(2);
  });

  it("a picked row that leaves the list takes its pick with it", async () => {
    ohbox = await mount({ newForYou: rows() });
    await ohbox.run(() => {
      ohbox!.model.togglePick("a");
      ohbox!.model.togglePick("b");
    });
    await ohbox.publish({ newForYou: rows().filter((m) => m.id !== "b") });
    expect(ohbox.model.pickedIds).toEqual(["a"]);
  });

  it("a folded row picks every letter it stands for", async () => {
    ohbox = await mount({
      newForYou: [
        msg({ id: "t2", threadId: "t", date: at(10) }),
        msg({ id: "t1", threadId: "t", date: at(9) }),
        msg({ id: "s", date: at(8) }),
      ],
    });
    await ohbox.run(() => {
      ohbox!.model.togglePick("t2");
    });
    expect([...ohbox.model.pickedIds].sort()).toEqual(["t1", "t2"]);
    expect(ohbox.model.pickedRowCount).toBe(1);
  });

  it("a verb that ran clears the pick; one refused at the press keeps it", async () => {
    ohbox = await mount({ newForYou: rows() }, { bulkRefuses: true });
    await ohbox.run(() => {
      ohbox!.model.togglePick("a");
      ohbox!.model.togglePick("b");
    });
    await ohbox.run(() => ohbox!.model.runBulk("move:reads"));
    expect(ohbox.calls.bulk).toEqual([{ action: "move:reads", ids: ["a", "b"] }]);
    expect(ohbox.model.pickedIds).toEqual(["a", "b"]);
    await ohbox.unmount();
    ohbox = await mount({ newForYou: rows() });
    await ohbox.run(() => {
      ohbox!.model.togglePick("a");
    });
    await ohbox.run(() => ohbox!.model.runBulk("later"));
    expect(ohbox.model.pickedIds).toEqual([]);
  });

  it("the row being read keeps its hold while a pick lives, and lets go when the pick ends", async () => {
    ohbox = await mount({ newForYou: rows() });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
    expect(ohbox.calls.held).toEqual(["a"]);
    await ohbox.run(() => {
      ohbox!.model.togglePick("b");
    });
    await ohbox.run(() => ohbox!.model.selectByUser("b"));
    expect(ohbox.calls.held).toEqual(["a"]);
    await ohbox.run(() => ohbox!.model.clearPicked());
    expect(ohbox.calls.held).toEqual(["a", null]);
  });
});
