import { describe, expect, it } from "vitest";
import { streamLeaveCommit, type StreamLeaveCommit, type StreamLeaveState } from "@ohmail/app-logic/streams";
import { createStreamLeave } from "../../../packages/app-logic/src/streams/leave.js";

const order = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, unread: i % 3 !== 0 }));

/** The leave states used by the shared News and Receipts model. */
const states: Array<[string, Omit<StreamLeaveState, "read"> & { reads: string[] }]> = [
  ["no hand drove the visit", { drove: false, newestSeenId: "r0", bottomVisibleId: "r4", reads: ["r1", "r2"] }],
  ["nothing was shown", { drove: true, newestSeenId: null, bottomVisibleId: "r3", reads: ["r1"] }],
  ["the newest shown left the pile", { drove: true, newestSeenId: "gone", bottomVisibleId: "r3", reads: ["r1"] }],
  ["a screen from the top", { drove: true, newestSeenId: "r0", bottomVisibleId: "r3", reads: ["r1", "r2", "r3"] }],
  ["only what was read rides", { drove: true, newestSeenId: "r2", bottomVisibleId: "r8", reads: ["r4", "r7", "r8"] }],
  ["a foot above the anchor", { drove: true, newestSeenId: "r5", bottomVisibleId: "r1", reads: ["r5", "r1"] }],
  ["no foot", { drove: true, newestSeenId: "r4", bottomVisibleId: null, reads: ["r4", "r5"] }],
  ["read cards that are not unread", { drove: true, newestSeenId: "r0", bottomVisibleId: "r9", reads: ["r0", "r3", "r6", "r9"] }],
];
const state = (s: Omit<StreamLeaveState, "read"> & { reads: string[] }): StreamLeaveState => ({
  drove: s.drove,
  newestSeenId: s.newestSeenId,
  bottomVisibleId: s.bottomVisibleId,
  read: (id) => s.reads.includes(id),
});


const expected: ReadonlyArray<StreamLeaveCommit | null> = [
  null,
  null,
  null,
  { upToId: "r0", messageIds: ["r1", "r2"] },
  { upToId: "r2", messageIds: ["r4", "r7", "r8"] },
  { upToId: "r5", messageIds: ["r5"] },
  { upToId: "r4", messageIds: ["r4"] },
  { upToId: "r0", messageIds: [] },
];

describe("the leave's commit: today's views and the places' stream agree", () => {
  // Both places use the same derivation and remember each visit's result before committing.
  for (const view of ["reads", "receipts"] as const) {
    it(`${view}: every leave state gives the same commit, or none on both sides`, () => {
      for (const [index, [name, held]] of states.entries()) {
        const leave = createStreamLeave();
        leave.remember(state(held), order);
        expect(leave.take(order, () => false), name).toEqual(expected[index]);
        expect(leave.take(order, () => false), name).toBeNull();
        expect(streamLeaveCommit(state(held), order), name).toEqual(expected[index]);
      }
    });
  }
});
