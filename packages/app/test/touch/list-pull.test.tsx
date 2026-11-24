/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullContext, type PullBinding } from "@ohmail/app-logic/session/pull-new-mail";
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { ListColumn } from "../../src/place-list/index.js";
import { TextProvider } from "../../src/text/index.js";
import { PULL_HOLD, PULL_HOLD_CAP_MS } from "../../src/touch/ListTouch.js";
import { wideWindow } from "../ohbox/setup.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { pullDown } from "./touch-world.js";

/*
 * EVERY MAIL LIST PULLS, NOT ONLY THE OHBOX: a list place's column pulled down at its top presses the mail ground's
 * one Pull new mail, once per pull. Let go past the mark, the room stays open with the waiting mark in it while that
 * pull runs, and closes when it is over or after the cap; a pull while one runs starts nothing.
 */

beforeEach(wideWindow);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface Ground {
  pulls: number;
  /** The pull pressed elsewhere (the rail's foot, `p`): it runs without a finger. */
  start(): void;
  finish(): void;
}

function listWorld(
  room: keyof typeof ROOMS = "phone",
  /** A pull that is over before anyone looks: the press starts nothing that runs. */
  instant = false,
): {
  ground: Ground;
  scroller(): HTMLElement;
  row(): HTMLElement;
} {
  const ground: Ground = { pulls: 0, start: () => {}, finish: () => {} };
  function Pane({ plan }: PaneProps) {
    const [pulling, setPulling] = useState(false);
    ground.start = () => setPulling(true);
    ground.finish = () => setPulling(false);
    const binding: PullBinding = {
      available: true,
      pulling,
      pull: () => {
        ground.pulls += 1;
        if (!instant) setPulling(true);
      },
    };
    return (
      <PullContext.Provider value={binding}>
        <ListColumn head={<h2>Receipts</h2>} plan={plan}>
          <div role="option" aria-selected="false" data-id="r1">
            Invoice
          </div>
        </ListColumn>
      </PullContext.Provider>
    );
  }
  /* The frame opens on the Ohbox's slot: the column stands there, as any list place's would. */
  const place: PlaceEntry = {
    id: "ohbox",
    body: "ohbox",
    rail: { group: "main", icon: "ohbox", label: "title" },
    panes: { kind: "columns", List: Pane, Reading: () => null },
  };
  const host = fakeHost({
    engine: NO_ENGINE,
    service: "self",
    scope: "acct-1",
    places: { ohbox: place },
    window: fakeWindow(room),
  }).host;
  const view = render(
    <TextProvider locale="en" messages={{ ...FRAME_WORDS.en }} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>,
  );
  const doc = view.container.ownerDocument;
  return {
    ground,
    scroller: () => doc.querySelector<HTMLElement>(".pl-scroll")!,
    row: () => doc.querySelector<HTMLElement>("[data-id='r1']")!,
  };
}

const room = () => document.querySelector<HTMLElement>(".tc-pull");
const mark = () => document.querySelector(".tc-pull .oh-spin");

describe("a pull at a list place's top", () => {
  it("presses the ground's pull once, and holds the waiting mark until that pull is over", () => {
    const world = listWorld();
    expect(room()!.style.height).toBe("0px");
    expect(mark()).toBeNull();
    pullDown(world.row(), 150);
    expect(world.ground.pulls).toBe(1);
    act(() => {});
    expect(room()!.style.height, "the room holds while the pull runs").toBe(`${PULL_HOLD}px`);
    expect(mark(), "the waiting mark stands in the room").not.toBeNull();
    act(() => world.ground.finish());
    expect(room()!.style.height, "the pull is over: the room closes").toBe("0px");
    expect(mark()).toBeNull();
  });

  it("shows the mark under the finger before letting go", () => {
    const world = listWorld();
    const letGo = pullDown(world.row(), 150, { hold: true });
    expect(room()!.style.height).not.toBe("0px");
    expect(mark()).not.toBeNull();
    letGo();
  });

  it("starts no second pull while the first runs, and keeps holding for the one that runs", () => {
    const world = listWorld();
    pullDown(world.row(), 150);
    act(() => {});
    pullDown(world.row(), 150);
    act(() => {});
    expect(world.ground.pulls).toBe(1);
    expect(room()!.style.height).toBe(`${PULL_HOLD}px`);
    act(() => world.ground.finish());
    expect(room()!.style.height).toBe("0px");
    pullDown(world.row(), 150);
    expect(world.ground.pulls).toBe(2);
  });

  it("a release while a pull pressed elsewhere runs starts nothing, and holds the mark for that pull", () => {
    const world = listWorld();
    act(() => world.ground.start());
    expect(room()!.style.height, "a pull from the rail opens no room by itself").toBe("0px");
    pullDown(world.row(), 150);
    act(() => {});
    expect(world.ground.pulls).toBe(0);
    expect(room()!.style.height).toBe(`${PULL_HOLD}px`);
    act(() => world.ground.finish());
    expect(room()!.style.height).toBe("0px");
  });

  it("holds nothing for a release whose pull was over at once, nor for a later pull from elsewhere", () => {
    const world = listWorld("phone", true);
    pullDown(world.row(), 150);
    act(() => {});
    expect(world.ground.pulls).toBe(1);
    expect(room()!.style.height).toBe("0px");
    act(() => world.ground.start());
    expect(room()!.style.height).toBe("0px");
  });

  it("never holds longer than the cap, though the pull still runs", () => {
    vi.useFakeTimers();
    const world = listWorld();
    pullDown(world.row(), 150);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(room()!.style.height).toBe(`${PULL_HOLD}px`);
    act(() => {
      vi.advanceTimersByTime(PULL_HOLD_CAP_MS);
    });
    expect(room()!.style.height).toBe("0px");
    expect(world.ground.pulls).toBe(1);
  });

  it("does not pull short of the mark, or from below the top", () => {
    const world = listWorld();
    pullDown(world.row(), 120);
    Object.defineProperty(world.scroller(), "scrollTop", { value: 10, configurable: true });
    pullDown(world.row(), 150);
    expect(world.ground.pulls).toBe(0);
  });

  it("is no pull under a mouse", () => {
    const world = listWorld("desktop");
    expect(room()).toBeNull();
    pullDown(world.row(), 150);
    expect(world.ground.pulls).toBe(0);
  });
});
