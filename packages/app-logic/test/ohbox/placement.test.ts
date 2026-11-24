/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * WHERE A ROW STANDS IN THE OHBOX: by arrival, never by when it was read. The engine hands New newest first; the
 * hook keeps the rows a person is looking at in their order and merges each new one in at the engine's rank.
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

const keys = (h: Harness, group: "groupedNew" | "groupedPrev") => h.model[group].map((r) => r.openTarget.id);

describe("the Ohbox's placement", () => {
  it("a new arrival enters at the top, above the rows already on screen", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "b", date: at(9) }), msg({ id: "c", date: at(8) })] });
    await ohbox.publish({
      newForYou: [
        msg({ id: "a", date: at(10) }),
        msg({ id: "b", date: at(9) }),
        msg({ id: "c", date: at(8) }),
      ],
    });
    expect(keys(ohbox, "groupedNew")).toEqual(["a", "b", "c"]);
  });

  it("an old unread that arrives late files at its date, below newer rows", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "b", date: at(9) }), msg({ id: "c", date: at(7) })] });
    await ohbox.publish({
      newForYou: [
        msg({ id: "b", date: at(9) }),
        msg({ id: "d", date: at(8) }),
        msg({ id: "c", date: at(7) }),
      ],
    });
    expect(keys(ohbox, "groupedNew")).toEqual(["b", "d", "c"]);
  });

  it("kept rows never reorder among themselves, whatever order a later publish hands", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "b", date: at(9) }), msg({ id: "c", date: at(8) })] });
    await ohbox.publish({ newForYou: [msg({ id: "c", date: at(8) }), msg({ id: "b", date: at(9) })] });
    expect(keys(ohbox, "groupedNew")).toEqual(["b", "c"]);
  });

  it("a row marked unread returns to its arrival place in New, not to the top", async () => {
    const e = msg({ id: "e", date: at(8), unread: false });
    ohbox = await mount({
      newForYou: [msg({ id: "b", date: at(10) }), msg({ id: "c", date: at(7) })],
      previouslySeen: [e],
    });
    await ohbox.run(() => ohbox!.model.markUnread(e));
    expect(ohbox.calls.marked).toEqual([{ ids: ["e"], unread: true }]);
    await ohbox.publish({
      newForYou: [
        msg({ id: "b", date: at(10) }),
        msg({ id: "e", date: at(8) }),
        msg({ id: "c", date: at(7) }),
      ],
      previouslySeen: [],
    });
    expect(keys(ohbox, "groupedNew")).toEqual(["b", "e", "c"]);
  });
});
