/** @vitest-environment jsdom */
/**
 * A STAGE THAT IS OWED. A stage stands over the app while the address names it, or while a part that lives for the
 * frame's life says it is owed (`useStageOwed`): then the address is left as it is, and the stage's body is drawn
 * with no stage named in its route. It leaves when neither holds. An address that names a stage wins over what is
 * owed, and a stage the host does not hand is stood by nothing.
 */
import type { ReactNode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import type { FramePlaces, FrameStages, PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { useSignal, useStageOwed } from "../../src/frame/index.js";
import { createFeed } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };

function List({ route }: PaneProps) {
  return <p>the list of {route.place}</p>;
}
function Reading() {
  return null;
}
const columns = (id: PlaceEntry["id"]): PlaceEntry => ({
  id,
  body: id,
  rail: null,
  panes: { kind: "columns", List, Reading },
});
const PLACES: Partial<FramePlaces> = { ohbox: columns("ohbox"), news: columns("news") };

/** The fixture stage: it says which run the address names, or that none is named (it stands because it is owed). */
function Body({ route }: PaneProps) {
  return <p>the first run, {route.stage === null ? "owed" : `named ${route.stage.words.how ?? "plain"}`}</p>;
}
const STAGES: FrameStages = { firstRun: { id: "firstRun", Body } };

/** A part above the panes that says the stage is owed twice over, each while its own feed says so; and whether it stands. */
const first = createFeed(false);
const second = createFeed(false);
const there = createFeed(true);
function Part() {
  useStageOwed("firstRun", useSignal(first));
  useStageOwed("firstRun", useSignal(second));
  return null;
}
function Owes({ children }: { readonly children: ReactNode }) {
  return (
    <>
      {useSignal(there) ? <Part /> : null}
      {children}
    </>
  );
}

function mount(at: string, stages: Partial<FrameStages> = STAGES) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress(at),
    places: PLACES,
    stages,
    above: Owes,
  });
  render(
    <TextProvider locale="en" messages={FRAME_WORDS.en} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
  return made;
}

const stage = () => screen.queryByRole("dialog", { name: frameEn.frame.landmark.stage });
const behind = () => screen.getByText("the list of ohbox").closest("[inert]");

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  first.set(false);
  second.set(false);
  there.set(true);
});
afterEach(cleanup);

describe("a stage that is owed", () => {
  it("stands over the app while a part says so, the address untouched, and leaves when the part stops", () => {
    const { address } = mount("#/ohbox");
    expect(stage()).toBeNull();
    expect(behind()).toBeNull();

    act(() => first.set(true));
    expect(stage()).not.toBeNull();
    expect(screen.getByText("the first run, owed")).toBeTruthy();
    /* The app behind is held: nothing in it takes a press or a key. */
    expect(behind()).not.toBeNull();
    expect(address.read()).toBe("#/ohbox");
    expect(address.writes).toEqual([]);

    act(() => first.set(false));
    expect(stage()).toBeNull();
    expect(behind()).toBeNull();
    expect(address.writes).toEqual([]);
  });

  it("stays through a walk between places, at whatever address", () => {
    const { address } = mount("#/ohbox");
    act(() => first.set(true));
    act(() => address.visit("#/reads"));
    expect(screen.getByText("the first run, owed")).toBeTruthy();
    expect(screen.getByText("the list of news").closest("[inert]")).not.toBeNull();
  });

  it("an address that names the stage wins, and the stage stays while either holds", () => {
    const { address } = mount("#/first-run/add");
    act(() => first.set(true));
    expect(screen.getByText("the first run, named add")).toBeTruthy();
    /* The owing ends: the address still names the run. */
    act(() => first.set(false));
    expect(screen.getByText("the first run, named add")).toBeTruthy();
    /* The address lets go while it is owed again: the stage stands on, as owed. */
    act(() => first.set(true));
    act(() => address.visit("#/ohbox"));
    expect(screen.getByText("the first run, owed")).toBeTruthy();
    act(() => first.set(false));
    expect(stage()).toBeNull();
  });

  it("owed by two parts, it stands until both have stopped", () => {
    mount("#/ohbox");
    act(() => {
      first.set(true);
      second.set(true);
    });
    expect(stage()).not.toBeNull();
    act(() => first.set(false));
    expect(stage()).not.toBeNull();
    act(() => second.set(false));
    expect(stage()).toBeNull();
  });

  it("a stage the host does not hand is stood by nothing: the app behind is not held", () => {
    mount("#/ohbox", {});
    act(() => first.set(true));
    expect(stage()).toBeNull();
    expect(behind()).toBeNull();
  });

  it("a part that goes takes its word with it: nothing it said stays behind in the frame", () => {
    mount("#/ohbox");
    act(() => first.set(true));
    expect(stage()).not.toBeNull();
    act(() => there.set(false));
    expect(stage()).toBeNull();
    expect(behind()).toBeNull();
  });
});
