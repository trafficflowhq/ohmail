/** @vitest-environment jsdom */
/**
 * WHAT A PLACE'S SEAT HANDS ITS LIVE HOOK. A place's behaviour lives in `@ohmail/app-logic`, which cannot read the
 * frame. Its seat hands the place's live hook the frame's side as one record (`usePlaceLiveArgs()`, typed
 * `PlaceLiveArgs` where the hook lives): the frame's one press seam, the scope it is mounted under, the route, the
 * commands, the plan and the report. The hook reads everything else itself.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Component, createContext, useContext, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlaceLiveArgs } from "@ohmail/app-logic/lists";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { usePlaceLiveArgs } from "../../src/frame/place-live.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/** A place's live hook as `app-logic` holds one: it takes the record and nothing of the frame. */
interface StubModel {
  readonly open: string | null;
  readonly sub: string | null;
  readonly columns: number;
  readonly held: number;
  readonly scope: string;
  openLetter(id: string | null): void;
  toNews(): void;
  say(sentence: string): void;
}
const seen: PlaceLiveArgs[] = [];
function useStubLive(args: PlaceLiveArgs): StubModel {
  if (seen[seen.length - 1] !== args) seen.push(args);
  return {
    open: args.route.open,
    sub: args.route.sub,
    columns: args.plan.columns,
    /* Read through the seam: at rest it holds no delete back, and a seam that is not mounted throws at this read. */
    held: args.press.deleting.held.size,
    scope: args.scope,
    openLetter: args.commands.open,
    toNews: () => args.commands.go({ place: "news" }),
    say: (sentence) => args.report(sentence),
  };
}

const Model = createContext<StubModel | null>(null);
/** The seat as every place's is: the live hook called once, its model stood above both columns. */
function Seat({ children }: { children: ReactNode }) {
  const model = useStubLive(usePlaceLiveArgs());
  return <Model.Provider value={model}>{children}</Model.Provider>;
}
function List(_: PaneProps) {
  const model = useContext(Model)!;
  const [, again] = useState(0);
  return (
    <div>
      <p>
        {`open ${model.open ?? "nothing"}, tag ${model.sub ?? "none"}, columns ${model.columns}, held ${model.held}, kept under ${model.scope}`}
      </p>
      <button type="button" onClick={() => model.openLetter("a1")}>
        Open
      </button>
      <button type="button" onClick={() => model.toNews()}>
        To News
      </button>
      <button type="button" onClick={() => model.say("Parked")}>
        Say
      </button>
      <button type="button" onClick={() => again((n) => n + 1)}>
        Draw again
      </button>
    </div>
  );
}
const tags: PlaceEntry = {
  id: "tags",
  body: "tags",
  rail: null,
  panes: { kind: "columns", List, Reading: () => <p>the letter</p>, Above: Seat },
};
const news: PlaceEntry = {
  id: "news",
  body: "news",
  rail: null,
  panes: { kind: "wide", Wide: () => <p>News</p> },
};

/** What a host stands above every pane: with it the room's own seam stands for the frame's life. */
function Ground({ children }: { children: ReactNode }) {
  return children;
}

class Caught extends Component<{ children: ReactNode }, { said: string | null }> {
  override state = { said: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { said: error instanceof Error ? error.message : String(error) };
  }
  override render() {
    return this.state.said === null ? this.props.children : <p>thrown: {this.state.said}</p>;
  }
}

function mount(more: Partial<FakeHostInput> = {}) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress("#/tag/t7"),
    places: { tags, news },
    above: Ground,
    ...more,
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Caught>
        <Frame host={made.host} />
      </Caught>
    </TextProvider>,
  );
  return made;
}

beforeEach(() => {
  seen.length = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("what a place's seat hands its live hook", () => {
  it("is the frame's own scope, route, plan, commands and report, and the room's press seam", () => {
    const { address, window } = mount();
    expect(screen.getByText("open nothing, tag t7, columns 2, held 0, kept under acct-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(address.read()).toBe("#/tag/t7/m/a1");
    expect(screen.getByText("open a1, tag t7, columns 2, held 0, kept under acct-1")).toBeTruthy();

    act(() => window.resize(390, 844, "coarse"));
    expect(screen.getByText("open a1, tag t7, columns 1, held 0, kept under acct-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Say" }));
    expect(screen.getByText("Parked")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "To News" }));
    expect(address.read()).toBe("#/reads");
    expect(screen.getByText("News")).toBeTruthy();
  });

  it("is one record while nothing of it moved, and a new one when the address does", () => {
    mount();
    expect(seen.length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Draw again" }));
    fireEvent.click(screen.getByRole("button", { name: "Say" }));
    expect(seen.length, "a draw and a report hand the hook the record it had").toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(seen.length).toBe(2);
    expect(seen[1]!.commands).toBe(seen[0]!.commands);
    expect(seen[1]!.route.open).toBe("a1");
  });

  it("throws where no room is on: a host that hands nothing above the panes and no reader has no seam", () => {
    mount({ above: "none" });
    expect(screen.getByText("thrown: usePress: no room is on here")).toBeTruthy();
  });
});
