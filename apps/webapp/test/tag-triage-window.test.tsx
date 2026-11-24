/** @vitest-environment jsdom */
import type { EngineMessage, TagEntity as TagDTO } from "@ohmail/wire";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { letter } from "../../../packages/app/test/reader/support/fake-mail.js";
import { listSeat } from "../../../packages/app/test/places/list-seat";
import { ESTIMATED_ROW_PX, FALLBACK_VIEWPORT_PX } from "@ohmail/app-logic/lists/list-window";

/**
 * A TAG AND A TRIAGE PILE MOUNT THEIR WINDOW. Neither list has an upper bound, and both mapped
 * every row into the list column on every visit; both now go through `useListWindow`, so a
 * viewport's rows mount over thousands and the rest is reserved height. Counts, not timers.
 */

afterEach(cleanup);

const ISO = "2026-08-04T09:00:00.000Z";
const N = 1200;
const ROWS_AT_TOP = Math.floor(FALLBACK_VIEWPORT_PX / ESTIMATED_ROW_PX) + 1 + 8;
const tag: TagDTO = { id: "t1", accountId: "acct-1", name: "Studio", hue: "moss", createdAt: ISO } as TagDTO;

const message = (i: number): EngineMessage => letter(`m${i}`, {
  subject: `subject of m${i}`,
  date: ISO,
  arrivedAt: ISO,
  labels: ["t1"],
});

describe("the Tag and Triage lists are windows", () => {
  it("a long tag mounts a viewport's rows, and a short tag renders whole", () => {
    const all = Array.from({ length: N }, (_, i) => message(i));
    const view = (letters: EngineMessage[]) => listSeat({
      first: "#/tag/t1", letters, more: { "tag:t1": tag },
    });
    view(all);
    expect(screen.getAllByRole("option")).toHaveLength(ROWS_AT_TOP);
    cleanup();
    view(all.slice(0, 30));
    expect(screen.getAllByRole("option")).toHaveLength(30);
  });


  it("an Answer Later pile of 1 200 mounts a viewport's rows, and a short pile renders whole", () => {
    const all = Array.from({ length: N }, (_, i) => message(i));
    const view = (letters: EngineMessage[]) => listSeat({
      first: "#/triage/reply",
      letters,
      more: Object.fromEntries(letters.map(({ id }) => [
        `message_state:${id}`,
        { messageId: id, state: "reply_later", bubbleUpAt: null, setAt: ISO, updatedAt: ISO },
      ])),
    });
    view(all);
    expect(screen.getAllByRole("option")).toHaveLength(ROWS_AT_TOP);
    cleanup();
    view(all.slice(0, 30));
    expect(screen.getAllByRole("option")).toHaveLength(30);
  });
});
