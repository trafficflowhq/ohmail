/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhboxListInput } from "../../src/ohbox/index.js";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * THE OHBOX HAS NO OLDER TAIL. Mail beyond what this device keeps is History's: a letter a shell still hands as
 * fetched from the server is no row here, no stop of the walk, no pick and nothing a verb acts on.
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

const fetched = msg({ id: "far", unread: false, date: "2025-01-02T09:00:00.000Z" });
const olderHanded = {
  older: {
    available: true,
    items: [fetched],
    loading: false,
    error: null,
    exhausted: false,
    loadMore: () => {},
    pending: false,
  },
} as unknown as Partial<OhboxListInput>;

describe("the end of the Ohbox", () => {
  it("draws no letter from beyond the window, and the walk ends at the last row of Earlier", async () => {
    ohbox = await mount({
      newForYou: [msg({ id: "a", date: at(10) })],
      previouslySeen: [msg({ id: "b", unread: false, date: at(8) })],
      ...olderHanded,
    });
    expect(ohbox.model.shown.map((m) => m.id)).toEqual(["a", "b"]);
    for (let i = 0; i < 4; i++) await ohbox.run(() => ohbox!.model.stepDown.run());
    expect(ohbox.model.selected?.id).toBe("b");
  });

  it("a pick of a letter that is no row leaves at once, so no verb acts on it", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "a", date: at(10) })], ...olderHanded });
    await ohbox.run(() => {
      ohbox!.model.togglePick("far");
    });
    expect(ohbox.model.pickedIds).toEqual([]);
  });
});
