import { describe, expect, it } from "vitest";
import {
  createStreamLeave,
  leaveSaysSomething,
  streamLeaveCommit,
  type StreamLeaveState,
} from "../../src/streams/leave.js";
import { createStreamReadRule } from "../../src/streams/read-rule.js";

const ORDER = [
  { id: "a", unread: true },
  { id: "b", unread: true },
  { id: "c", unread: false },
  { id: "d", unread: true },
  { id: "e", unread: true },
];
const state = (over: Partial<StreamLeaveState> = {}): StreamLeaveState => ({
  drove: true,
  newestSeenId: "b",
  bottomVisibleId: "d",
  read: () => true,
  ...over,
});

describe("the waterline on leaving a stream", () => {
  it("moves to the newest item shown and flips the unread ids read down to the last screen", () => {
    expect(streamLeaveCommit(state(), ORDER)).toEqual({ upToId: "b", messageIds: ["b", "d"] });
  });

  it("moves only after a hand drove the stream", () => {
    expect(streamLeaveCommit(state({ drove: false }), ORDER)).toBeNull();
  });

  it("writes nothing where nothing was shown or the item has left the stream", () => {
    expect(streamLeaveCommit(state({ newestSeenId: null }), ORDER)).toBeNull();
    expect(streamLeaveCommit(state({ newestSeenId: "gone" }), ORDER)).toBeNull();
  });

  it("never flips an item the visit did not read, or one marked unread", () => {
    const read = (id: string) => id !== "d";
    expect(streamLeaveCommit(state({ read }), ORDER)).toEqual({ upToId: "b", messageIds: ["b"] });
  });

  it("never flips what stood below the last screen", () => {
    expect(streamLeaveCommit(state({ bottomVisibleId: "b" }), ORDER)).toEqual({
      upToId: "b",
      messageIds: ["b"],
    });
    expect(streamLeaveCommit(state({ bottomVisibleId: null }), ORDER)).toEqual({
      upToId: "b",
      messageIds: ["b"],
    });
  });

  it("sends a commit only where it flips something or moves the line", () => {
    expect(leaveSaysSomething({ upToId: "b", messageIds: [] }, "b")).toBe(false);
    expect(leaveSaysSomething({ upToId: "b", messageIds: [] }, "a")).toBe(true);
    expect(leaveSaysSomething({ upToId: "b", messageIds: ["b"] }, "b")).toBe(true);
  });

  it("keeps the read earned for an unloaded letter when a passive preview resets the reading rule", () => {
    const rule = createStreamReadRule();
    const leave = createStreamLeave();
    const earlier = { id: "earlier-unloaded", top: 0, height: 200, unread: true, ready: false };
    const preview = { id: "unattended-preview", top: 850, height: 200, unread: true, ready: true };
    const items = [earlier, preview];
    const opening = { scrollTop: 0, viewHeight: 450, scrollHeight: 1800, items, at: 0 };
    rule.look(opening, true, false);
    rule.hand("wheel", 50);
    expect(rule.look({ ...opening, scrollTop: 200, at: 75 }, true, false)).toEqual([]);
    leave.remember(state({ newestSeenId: earlier.id, bottomVisibleId: earlier.id, read: rule.read }), items);
    rule.preview();

    const previewed = { ...opening, scrollTop: 800, at: 1250 };
    expect(rule.look(previewed, true, false)).toEqual([]);
    expect(rule.rest(previewed, preview.id, preview.id)).toEqual([]);
    leave.remember(
      state({
        drove: rule.handDrove,
        newestSeenId: preview.id,
        bottomVisibleId: preview.id,
        read: rule.read,
      }),
      items,
    );
    expect(leave.take(items, rule.keptUnread)).toEqual({ upToId: earlier.id, messageIds: [earlier.id] });
    expect(leave.take(items, rule.keptUnread)).toBeNull();
  });

  it("combines authorized scans once, skipping a now-read or marked-unread message", () => {
    const leave = createStreamLeave();
    leave.remember(state(), ORDER);
    leave.remember(state({ newestSeenId: "a", bottomVisibleId: "b" }), ORDER);
    leave.remember(state({ drove: false, newestSeenId: "e", bottomVisibleId: "e" }), ORDER);
    const current = ORDER.map((row) => (row.id === "b" ? { ...row, unread: false } : row));
    expect(leave.take(current, (id) => id === "d")).toEqual({ upToId: "a", messageIds: ["a"] });
    expect(leave.take(current, () => false)).toBeNull();
  });
});
