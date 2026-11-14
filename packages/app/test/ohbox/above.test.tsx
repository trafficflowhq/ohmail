/** @vitest-environment jsdom */
import { cleanup, render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { OhboxModelContext, useOhboxModel, type OhboxListModel } from "@ohmail/app-logic/ohbox";
import { useListBlank, useListVisit, type ListVisit } from "@ohmail/app-logic/reading";
import { OhboxAbove, blankOf, ohboxPlace, useOhboxBeside } from "../../src/ohbox/index.js";
import { TextProvider } from "../../src/text/index.js";
import { beside, WORDS } from "./ohbox-world.js";

afterEach(cleanup);

const words = (key: string, values?: Record<string, unknown>): string =>
  values ? `${key} ${JSON.stringify(values)}` : key;
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}` })) as never[];
const step = { disabled: false, run: () => {}, label: "" };

describe("what stands above the Ohbox's columns", () => {
  it("the blank says nothing with no rows, withholds the count until it may, then the count, then All read", () => {
    expect(blankOf({ all: [], mayState: true, unreadIds: [] }, words)).toBeNull();
    expect(blankOf({ all: rows(2), mayState: false, unreadIds: ["m0"] }, words)).toEqual({
      label: "blank.none",
      hot: false,
    });
    expect(blankOf({ all: rows(2), mayState: true, unreadIds: ["m0"] }, words)).toEqual({
      label: 'blank.unread {"count":1}',
      hot: true,
    });
    expect(blankOf({ all: rows(2), mayState: true, unreadIds: [] }, words)).toEqual({
      label: "blank.clear",
      hot: false,
    });
  });

  it("stands the model, the words beside it and the meeting the reading column reads", () => {
    const visit: ListVisit = {
      openId: "a",
      unread: true,
      wiring: {} as ListVisit["wiring"],
      readSet: [],
      act: () => {},
      step: { up: step, down: step },
    };
    const model = { all: rows(1), mayState: true, unreadIds: ["m0"], visit } as unknown as OhboxListModel;
    const seen: Record<string, unknown> = {};
    function Reads() {
      seen.model = useOhboxModel();
      seen.beside = useOhboxBeside();
      seen.visit = useListVisit("a");
      seen.blank = useListBlank();
      return null;
    }
    const side = beside({ marked: [], bulk: [], went: [], pulled: 0, markedAll: [] });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="UTC">
        <OhboxAbove model={model} beside={side}>
          <Reads />
        </OhboxAbove>
      </TextProvider>,
    );
    expect(seen.model).toBe(model);
    expect(seen.beside).toBe(side);
    expect(seen.visit).toBe(visit);
    expect(seen.blank).toEqual({ label: "1 unread", hot: true });
  });

  it("with nothing above, the list's model is asked of nobody and throws", () => {
    function Lost() {
      useOhboxModel();
      return null;
    }
    expect(() =>
      render(
        <OhboxModelContext.Provider value={null}>
          <Lost />
        </OhboxModelContext.Provider>,
      ),
    ).toThrow(/no model above it/);
  });

  it("the rail's count is the engine's unread letters, withheld until the Ohbox may state it", () => {
    let model = { all: rows(3), mayState: false, unreadIds: ["m0", "m1"] } as unknown as OhboxListModel;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <OhboxModelContext.Provider value={model}>{children}</OhboxModelContext.Provider>
    );
    const count = renderHook(() => ohboxPlace.rail!.useCount!(), { wrapper });
    expect(count.result.current, "a count stated before the Ohbox may").toBeNull();
    model = { ...model, mayState: true } as OhboxListModel;
    count.rerender();
    expect(count.result.current).toEqual({ count: "2", hot: true });
    model = { ...model, unreadIds: [] } as OhboxListModel;
    count.rerender();
    expect(count.result.current).toBeNull();
  });
});
