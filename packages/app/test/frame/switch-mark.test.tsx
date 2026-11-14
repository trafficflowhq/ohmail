/** @vitest-environment jsdom */
/**
 * A MOVE BETWEEN PLACES IS TIMED (the switch mark): the frame's `go` starts it when the place or its part changes, and
 * the seat of the place it goes to ends it once its own rows or its empty state are on screen; a placeholder ends
 * nothing; a letter opened alone is no switch; and a way back to a place whose seat left is timed again.
 */
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetUiVitalsForTest, takeUiVitals, useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import { useFrame } from "../../src/frame/commands.js";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry, PlaceRail } from "../../src/frame/contract.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const ready = { history: false };
function Ways() {
  const { commands } = useFrame();
  return (
    <>
      <button type="button" onClick={() => commands.go({ place: "ohbox" })}>
        To the Ohbox
      </button>
      <button type="button" onClick={() => commands.go({ place: "history" })}>
        To History
      </button>
      <button type="button" onClick={() => commands.go({ place: "trash" })}>
        To Trash
      </button>
      <button type="button" onClick={() => commands.open("m1")}>
        Open a letter
      </button>
    </>
  );
}
function Ohbox({ route }: PaneProps) {
  useSwitchEnded(route, true);
  return <Ways />;
}
/** A place whose seat does not call the hook yet (its mount's line is owed). */
function Trash() {
  return <Ways />;
}
function History({ route }: PaneProps) {
  useSwitchEnded(route, ready.history);
  return <Ways />;
}
const rail = (group: PlaceRail["group"]): PlaceRail => ({ group, icon: "ohbox", label: "title" });
const wide = (id: PlaceEntry["id"], Wide: (p: PaneProps) => ReactNode): PlaceEntry => ({
  id,
  body: id,
  rail: rail("main"),
  panes: { kind: "wide", Wide },
});
const PLACES = {
  ohbox: wide("ohbox", Ohbox),
  history: wide("history", History),
  trash: wide("trash", Trash),
};
const WORDS = {
  ...FRAME_WORDS.en,
  ohbox: { ...(FRAME_WORDS.en.ohbox as object), title: "Ohbox" },
  history: { title: "History" },
  trash: { title: "Trash" },
};

function mount(at: string) {
  const made = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    window: fakeWindow("desktop"),
    address: fakeAddress(at),
    places: PLACES,
  });
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Frame host={made.host} />
    </TextProvider>,
  );
}
const painted = () =>
  act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  localStorage.clear();
  ready.history = false;
  resetUiVitalsForTest();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the switch mark in the new shell", () => {
  it("a move to a place whose seat shows only a placeholder ends nothing", async () => {
    mount("#/ohbox");
    await painted();
    takeUiVitals();
    press("To History");
    await painted();
    expect(takeUiVitals().switchCount, "a placeholder ended the switch").toBe(0);
  });

  it("a move to a place whose seat is on screen at once is one switch", async () => {
    ready.history = true;
    mount("#/ohbox");
    await painted();
    takeUiVitals();
    press("To History");
    await painted();
    expect(takeUiVitals().switchCount).toBe(1);
  });

  it("a letter opened alone is no switch", async () => {
    mount("#/ohbox");
    await painted();
    takeUiVitals();
    press("Open a letter");
    await painted();
    expect(takeUiVitals().switchCount).toBe(0);
  });

  it("a way back to a place whose seat left is timed again, though the place between ended nothing", async () => {
    mount("#/ohbox");
    await painted();
    takeUiVitals();
    press("To Trash");
    await painted();
    press("To the Ohbox");
    await painted();
    expect(takeUiVitals().switchCount, "the way back to the Ohbox was not timed").toBe(1);
  });
});
