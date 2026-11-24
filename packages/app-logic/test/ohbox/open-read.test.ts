/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * A LETTER OPENED IN OHMAIL IS AN OPEN READ: entering it holds its row in New (the engine files it at the top of
 * Earlier when it is left), leaving lets go, and the row the engine re-files slides out of New over 280 ms.
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

describe("the open read", () => {
  it("entering an unread letter holds its row; leaving it lets go", async () => {
    const a = msg({ id: "a", date: at(10) });
    const b = msg({ id: "b", date: at(9) });
    ohbox = await mount({ newForYou: [a, b] });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
    expect(ohbox.calls.held).toEqual(["a"]);
    expect(ohbox.calls.selected).toEqual(["a"]);
    expect(ohbox.calls.marked).toEqual([]);
    await ohbox.run(() => ohbox!.model.selectByUser("b"));
    expect(ohbox.calls.held).toEqual(["a", null]);
  });

  it("a row the engine re-files under Earlier keeps its slot while it slides, then leaves New", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "a", date: at(10) }), msg({ id: "b", date: at(9) })] });
    await ohbox.publish({
      newForYou: [msg({ id: "b", date: at(9) })],
      previouslySeen: [msg({ id: "a", date: at(10), unread: false })],
    });
    expect(ohbox.model.groupedNew.map((r) => r.openTarget.id)).toEqual(["a", "b"]);
    expect(ohbox.model.settling.has("a")).toBe(true);
    await ohbox.run(() => {
      vi.advanceTimersByTime(279);
    });
    expect(ohbox.model.groupedNew.map((r) => r.openTarget.id)).toEqual(["a", "b"]);
    await ohbox.run(() => {
      vi.advanceTimersByTime(1);
    });
    expect(ohbox.model.groupedNew.map((r) => r.openTarget.id)).toEqual(["b"]);
    expect(ohbox.model.groupedPrev.map((r) => r.openTarget.id)).toEqual(["a"]);
  });

  it("a read letter opened holds nothing", async () => {
    ohbox = await mount({ previouslySeen: [msg({ id: "r", unread: false })] });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedPrev[0]!));
    expect(ohbox.calls.held).toEqual([]);
  });
});
