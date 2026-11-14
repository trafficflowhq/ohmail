/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANDING_REST_MS } from "../../src/reading/index.js";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * NOTHING NEVER ON SCREEN TURNS READ. Walking the list by key writes nothing; a landing is a preview the reader
 * enters only once rested on; what turns read is the thread-read rule's, and it says it was a glance.
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

const five = () => ["a", "b", "c", "d", "e"].map((id, i) => msg({ id, date: at(10 - i) }));

describe("the read rule in the list", () => {
  it("j and k walk the rows and write nothing", async () => {
    ohbox = await mount({ newForYou: five() });
    for (let i = 0; i < 5; i++) await ohbox.run(() => ohbox!.model.stepDown.run());
    await ohbox.run(() => ohbox!.model.stepUp.run());
    expect(ohbox.calls.selected).toEqual(["a", "b", "c", "d", "e", "d"]);
    expect(ohbox.calls.marked).toEqual([]);
    expect(ohbox.calls.held).toEqual([]);
  });

  it("a landing is a preview, entered only once rested on", async () => {
    ohbox = await mount({ newForYou: five() });
    await ohbox.run(() => ohbox!.model.stepDown.run());
    expect(ohbox.model.wiring?.previewing).toBe(true);
    expect(ohbox.model.wiring?.restMs).toBe(LANDING_REST_MS);
    await ohbox.run(() => ohbox!.model.wiring!.onEnter());
    expect(ohbox.calls.held).toEqual(["a"]);
    expect(ohbox.calls.marked).toEqual([]);
  });

  it("the rule's read is a glance", async () => {
    ohbox = await mount({ newForYou: five() });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
    await ohbox.run(() => ohbox!.model.wiring!.onRead(["a"]));
    expect(ohbox.calls.marked).toEqual([{ ids: ["a"], unread: false, via: "glance" }]);
  });
});
