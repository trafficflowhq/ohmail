/** @vitest-environment jsdom */
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createThreadRead, type EngineMessage } from "@ohmail/client-engine";
import type { ThreadReadWiring } from "../../src/reading/reader-seen.js";
import { useColumnVisit, type ColumnVisit } from "../../src/reader/visit.js";

/**
 * ONE RECORD PER OPEN LETTER. Where the list that opened a letter handed its visit, the column runs the list's and
 * keeps none of its own (two records would read one dwell twice); with none handed, the column's own, its dot look.
 */

const letter = { id: "m1", unread: true } as EngineMessage;
afterEach(cleanup);

function visitOf(handed: ThreadReadWiring | null, marks: unknown[][] = []): ColumnVisit {
  return renderHook(() =>
    useColumnVisit(letter, handed, (...args) => {
      marks.push(args);
      return true;
    }),
  ).result.current;
}

describe("the column's visit", () => {
  it("runs the list's where one was handed, and enters through it", () => {
    let entered = 0;
    const handed: ThreadReadWiring = {
      look: "tint",
      record: createThreadRead(),
      onRead: () => {},
      onEnter: () => {
        entered += 1;
      },
      onMarkUnread: () => {},
    };
    const visit = visitOf(handed);
    expect(visit.owner).toBe("list");
    expect(visit.wiring).toBe(handed);
    visit.enter();
    expect(entered).toBe(1);
  });

  it("keeps a record of its own only where none was handed: the dot look, its reads as glances naming the row", () => {
    const marks: unknown[][] = [];
    const own = visitOf(null, marks);
    expect(own.owner).toBe("column");
    expect(own.wiring?.look).toBe("dot");
    own.wiring!.onRead(["m1"]);
    expect(marks).toEqual([[["m1"], false, "glance", "m1"]]);
  });

  it("a Mark unread of the column's own is kept for the visit and written once", () => {
    const marks: unknown[][] = [];
    const own = visitOf(null, marks);
    own.wiring!.onMarkUnread("m1");
    expect(marks).toEqual([[["m1"], true]]);
  });
});
