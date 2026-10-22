import { describe, expect, it } from "vitest";
import { windowAnswerStale, windowOwnersOf } from "../app/shell/consent-state";

/**
 * IS THE WINDOW ANSWER OLDER THAN THE ROLES (R20-02). `GET /consent` answers each mailbox's window
 * by its role: `own` on a mailbox this install organizes, never `own` on one it reads. A promotion
 * moves the role on `GET /mailboxes` and rings no `/sync` row for a mailbox that never had a
 * document, so the shell compares the two and re-asks once when they disagree.
 */

const own = { baselineAt: "2026-10-01T00:00:00.000Z", dormancyDays: 90, scope: "window", source: "own" as const };
const unread = { baselineAt: null, dormancyDays: 60, scope: "all_time", source: "unread" as const };
const organizer = { ...own, source: "organizer" as const };
const sourceless = { baselineAt: null, dormancyDays: 60, scope: "window" };

describe("windowAnswerStale", () => {
  const cases: Array<[string, Parameters<typeof windowAnswerStale>[0], string | null, boolean]> = [
    ["an organizer answered `own`", { a: own }, "a:organizer", false],
    ["a reader answered by its organizer", { a: organizer }, "a:reader", false],
    ["a reader answered `unread`", { a: unread }, "a:reader", false],
    ["promoted, but the answer is still the reader's", { a: unread }, "a:organizer", true],
    ["promoted, the organizer's window still applied", { a: organizer }, "a:organizer", true],
    ["demoted, the answer still `own`", { a: own }, "a:reader", true],
    ["a mailbox the answer lacks (the add path)", { a: own }, "a:organizer,b:reader", true],
    ["no map (an older server)", null, "a:organizer", false],
    ["no facts yet", { a: unread }, null, false],
    ["an entry without a source never asks", { a: sourceless }, "a:organizer", false],
  ];
  for (const [what, map, owners, stale] of cases) {
    it(what, () => expect(windowAnswerStale(map, owners)).toBe(stale));
  }
});

describe("windowOwnersOf", () => {
  it("sorted id:role pairs, the roleless left out", () => {
    expect(windowOwnersOf([
      { id: "b", organizerRole: "reader" }, { id: "a", organizerRole: "organizer" }, { id: "c" },
    ])).toBe("a:organizer,b:reader");
  });
  it("null with no facts", () => {
    expect(windowOwnersOf(null)).toBeNull();
  });
  it("a poll that moves only counters keeps the key", () => {
    const one = windowOwnersOf([{ id: "a", organizerRole: "organizer", lastSyncAt: "1" } as never]);
    const two = windowOwnersOf([{ id: "a", organizerRole: "organizer", lastSyncAt: "2" } as never]);
    expect(one).toBe(two);
  });
});
