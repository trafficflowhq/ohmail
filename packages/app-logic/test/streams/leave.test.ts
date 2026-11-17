import { describe, expect, it } from "vitest";
import { leaveSaysSomething, streamLeaveCommit, type StreamLeaveState } from "../../src/streams/leave.js";

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
});
