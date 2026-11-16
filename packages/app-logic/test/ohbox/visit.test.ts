/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * WHAT THE OHBOX HANDS THE READING COLUMN: the visit of the open letter, the same wiring the list keeps, and the
 * pane's verbs through the list's own path.
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

describe("the visit", () => {
  it("stands only while a letter is open, and carries the list's own wiring", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "a" })] });
    expect(ohbox.model.visit).toBeNull();
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
    expect(ohbox.model.visit?.openId).toBe("a");
    expect(ohbox.model.visit?.wiring).toBe(ohbox.model.wiring);
    expect(ohbox.model.visit?.unread).toBe(true);
  });

  it("a letter that came back reads unread whatever its stored flag", async () => {
    const back = { ...msg({ id: "p", unread: false }), triage: { state: "resurfaced" } } as never;
    ohbox = await mount({
      resurfacedRows: [
        {
          key: "msg:p",
          threadId: null,
          members: [back],
          pinned: [back],
          openTarget: back,
          count: 1,
          countFromThread: false,
          resurfacedAt: null,
          newSince: [],
          badge: false,
          pulledForward: false,
        },
      ],
    });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedResurfaced[0]!));
    expect(ohbox.model.visit?.unread).toBe(true);
  });

  it("the read slot's press reads the set in one press, or with none marks the letter unread and holds it", async () => {
    ohbox = await mount({
      newForYou: [
        msg({ id: "a", threadId: "t", date: at(11) }),
        msg({ id: "a0", threadId: "t", date: at(10) }),
      ],
      readSetFor: () => ["a", "a0"],
    });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
    await ohbox.run(() => ohbox!.model.visit!.act("unread"));
    expect(ohbox.calls.bulk).toEqual([{ action: "read", ids: ["a", "a0"] }]);
    await ohbox.unmount();
    ohbox = await mount({ previouslySeen: [msg({ id: "r", unread: false })], readSetFor: () => [] });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedPrev[0]!));
    await ohbox.run(() => ohbox!.model.visit!.act("unread"));
    expect(ohbox.calls.marked).toEqual([{ ids: ["r"], unread: true }]);
  });

  it("every other verb reaches the shell with the open letter", async () => {
    const acted: Array<[string, string]> = [];
    ohbox = await mount({
      newForYou: [msg({ id: "a" })],
      onAction: (a, m) => {
        acted.push([a, m.id]);
      },
    });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
    await ohbox.run(() => ohbox!.model.visit!.act("later"));
    expect(acted).toEqual([["later", "a"]]);
  });
});
