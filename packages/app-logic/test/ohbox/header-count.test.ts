/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mount, msg, wide, type Harness } from "./harness.js";

/*
 * A COUNT IS THE ENGINE'S, NEVER GUESSED: the head's number is the unread set the rail counts, and it is not
 * stated before the mailbox has been read through.
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

describe("the head's count", () => {
  it("is the unread letters of the three groups, never the rows drawn", async () => {
    ohbox = await mount({
      newForYou: [msg({ id: "a" }), msg({ id: "b", threadId: "t" }), msg({ id: "c", threadId: "t" })],
      previouslySeen: [msg({ id: "r", unread: false }), msg({ id: "u", unread: true, date: at(6) })],
    });
    expect([...ohbox.model.unreadIds].sort()).toEqual(["a", "b", "c", "u"]);
    expect(ohbox.model.mayState).toBe(true);
  });

  it("is withheld until the mailbox is read through, and while mail is still owed", async () => {
    ohbox = await mount({ newForYou: [msg({ id: "a" })], settled: false });
    expect(ohbox.model.mayState).toBe(false);
    expect(ohbox.model.all).toHaveLength(1);
    await ohbox.publish({ settled: true, owed: true });
    expect(ohbox.model.mayState).toBe(false);
    await ohbox.publish({ owed: false });
    expect(ohbox.model.mayState).toBe(true);
  });
});
