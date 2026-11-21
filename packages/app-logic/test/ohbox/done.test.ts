/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResurfacedThreadRow } from "@ohmail/client-engine";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * DONE ON EVERY ROW THAT WAITS. A pinned row's Done releases its pins; the open row's Done is the reader's Mark
 * as read; any other row's Done reads its unread letters, never our own Sent copy, and never what is read.
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

describe("Done on a row", () => {
  it("one unread letter is marked read on its own", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "a" }), msg({ id: "b", date: at(8) })] });
    await ohbox.run(() => ohbox!.model.doneRow(ohbox!.model.groupedNew[1]!));
    expect(ohbox.calls.marked).toEqual([{ ids: ["b"], unread: false }]);
    expect(ohbox.calls.bulk).toEqual([]);
  });

  it("a conversation's unread letters go as one read, without the read one and without our own Sent copy", async () => {
    ohbox = await mount({
      newForYou: [
        msg({ id: "c3", threadId: "t", date: at(11) }),
        msg({ id: "c2", threadId: "t", date: at(10) }),
      ],
      previouslySeen: [
        msg({ id: "c1", threadId: "t", date: at(9), unread: false }),
        msg({ id: "s1", threadId: "t", date: at(10, 30), folder: "Sent", unread: true }),
      ],
    });
    const row = ohbox.model.groupedNew[0]!;
    expect(row.members.map((m) => m.id).sort()).toEqual(["c1", "c2", "c3", "s1"]);
    await ohbox.run(() => ohbox!.model.doneRow(row));
    expect(ohbox.calls.bulk).toEqual([{ action: "read", ids: ["c3", "c2"] }]);
    expect(ohbox.calls.marked).toEqual([]);
  });

  it("the open row's Done is the reader's Mark as read", async () => {
    ohbox = await mount({
      newForYou: [
        msg({ id: "a", threadId: "t", date: at(11) }),
        msg({ id: "a0", threadId: "t", date: at(10) }),
      ],
      readSetFor: () => ["a", "a0"],
    });
    await ohbox.run(() => ohbox!.model.pressRow(ohbox!.model.groupedNew[0]!));
    await ohbox.run(() => ohbox!.model.doneRow(ohbox!.model.groupedNew[0]!));
    expect(ohbox.calls.bulk).toEqual([{ action: "read", ids: ["a", "a0"] }]);
  });

  it("a pinned row releases every pin in one press", async () => {
    const p1 = msg({ id: "p1", threadId: "t", date: at(8), triage: { state: "resurfaced" } as never });
    const p2 = msg({ id: "p2", threadId: "t", date: at(7), triage: { state: "resurfaced" } as never });
    const row: ResurfacedThreadRow = {
      key: "t",
      threadId: "t",
      members: [p1, p2],
      pinned: [p1, p2],
      openTarget: p1,
      count: 2,
      countFromThread: false,
      resurfacedAt: null,
      newSince: [],
      badge: false,
      pulledForward: false,
    };
    ohbox = await mount({ resurfacedRows: [row] });
    const drawn = ohbox.model.groupedResurfaced[0]!;
    await ohbox.run(() => ohbox!.model.doneRow(drawn));
    expect(ohbox.calls.bulk).toEqual([{ action: "done", ids: ["p1", "p2"] }]);
  });

  it.each([1, 2])("marks %i unread messages with a pin-preserving read", async (count) => {
    const pinned = Array.from({ length: count }, (_, i) =>
      msg({ id: `p${i}`, threadId: "t", triage: { state: "resurfaced" } as never }),
    );
    const row: ResurfacedThreadRow = {
      key: "t",
      threadId: "t",
      members: pinned,
      pinned,
      openTarget: pinned[0]!,
      count,
      countFromThread: false,
      resurfacedAt: null,
      newSince: [],
      badge: false,
      pulledForward: false,
    };
    ohbox = await mount({ resurfacedRows: [row] });
    await ohbox.run(() => ohbox!.model.markRowRead(ohbox!.model.groupedResurfaced[0]!));
    expect(ohbox.calls.marked).toEqual([]);
    expect(ohbox.calls.bulk).toEqual([{ action: "read", ids: pinned.map((m) => m.id), via: "glance" }]);
  });

  it("a read row offers nothing to be done", async () => {
    ohbox = await mount({ previouslySeen: [msg({ id: "r", unread: false })] });
    expect(ohbox.model.doneOffered(ohbox.model.groupedPrev[0]!)).toBe(false);
    await ohbox.run(() => ohbox!.model.doneRow(ohbox!.model.groupedPrev[0]!));
    expect(ohbox.calls.marked).toEqual([]);
    expect(ohbox.calls.bulk).toEqual([]);
  });
});
