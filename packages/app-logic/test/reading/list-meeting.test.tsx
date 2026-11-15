/** @vitest-environment jsdom */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  ListMeetingContext,
  useListBlank,
  useListVisit,
  type ListBlank,
  type ListMeeting,
  type ListVisit,
} from "../../src/reading/index.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => void) => void }).act;
const h = React.createElement;

const step = { disabled: false, run: () => {}, label: "next" };
const visitOf = (openId: string): ListVisit => ({
  openId,
  unread: true,
  wiring: {} as ListVisit["wiring"],
  readSet: [],
  act: () => {},
  step: { up: step, down: step },
});

/** What the column reads under a meeting (or none), for the letter it shows. */
function read(
  meeting: ListMeeting | null,
  openId: string | null,
): { visit: ListVisit | null; blank: ListBlank | null | undefined } {
  const seen: { visit: ListVisit | null; blank: ListBlank | null | undefined } = {
    visit: null,
    blank: undefined,
  };
  function Column() {
    seen.visit = useListVisit(openId);
    seen.blank = useListBlank();
    return null;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(meeting === null ? h(Column) : h(ListMeetingContext.Provider, { value: meeting }, h(Column)));
  });
  act(() => {
    root.unmount();
  });
  return seen;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("what a list hands the reading column", () => {
  it("gives the visit of exactly the letter shown, and never one of another letter", () => {
    const a = visitOf("a");
    expect(read({ visit: a, blank: null }, "a").visit).toBe(a);
    expect(read({ visit: a, blank: null }, "b").visit).toBeNull();
    expect(read({ visit: a, blank: null }, null).visit).toBeNull();
  });

  it("with no list above gives no visit, and says the column speaks its own word", () => {
    const seen = read(null, "a");
    expect(seen.visit).toBeNull();
    expect(seen.blank).toBeUndefined();
  });

  it("hands the list's blank, or null where the list says nothing", () => {
    expect(read({ visit: null, blank: { label: "5 unread", hot: true } }, null).blank).toEqual({
      label: "5 unread",
      hot: true,
    });
    expect(read({ visit: null, blank: null }, null).blank).toBeNull();
  });
});
