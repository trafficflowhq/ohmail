/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullContext, type PullBinding } from "@ohmail/app-logic/session/pull-new-mail";
import { PULL_HOLD, PULL_HOLD_CAP_MS } from "@ohmail/app-logic/touch";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import { Frame } from "../../src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { ListColumn } from "../../src/place-list/index.js";
import { TextProvider } from "../../src/text/index.js";
import { wideWindow } from "../ohbox/setup.js";
import { fakeHost, NO_ENGINE } from "../support/fake-host.js";
import { fakeWindow, ROOMS } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import { pullDown, pulledDistance } from "./touch-world.js";

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
  finish(result?: PullBinding["result"]): void;
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
    const [result, setResult] = useState<PullBinding["result"]>();
    ground.start = () => {
      setResult(undefined);
      setPulling(true);
    };
    ground.finish = (outcome) => {
      setResult(outcome);
      setPulling(false);
    };
    const binding: PullBinding = {
      available: true,
      pulling,
      result,
      pull: () => {
        ground.pulls += 1;
        if (!instant) ground.start();
      },
    };
    return (
      <PullContext.Provider value={binding}>
        <ListColumn head={<h2>Receipts</h2>} plan={plan}>
          <div role="option" aria-selected="false" data-id="r1">
            Invoice
          </div>
          <button type="button">List control</button>
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
    <TextProvider locale="en" messages={{ ...FRAME_WORDS.en, sync: frameEn.sync }} timeZone="UTC">
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
const mark = () => room()?.firstElementChild ?? null;

describe("a pull at a list place's top", () => {
  it("presses the ground's pull once, and holds the waiting mark until that pull is over", () => {
    const world = listWorld();
    expect(pulledDistance(world.scroller())).toBe(0);
    expect(mark()).toBeNull();
    pullDown(world.row(), 150);
    expect(world.ground.pulls).toBe(1);
    act(() => {});
    expect(pulledDistance(world.scroller()), "the room holds while the pull runs").toBe(PULL_HOLD);
    expect(mark(), "the waiting mark stands in the room").not.toBeNull();
    expect(mark()?.children).toHaveLength(3);
    act(() => world.ground.finish());
    expect(pulledDistance(world.scroller()), "the pull is over: the room closes").toBe(0);
    expect(mark()).toBeNull();
  });

  it("shows the mark under the finger before letting go", () => {
    const world = listWorld();
    const letGo = pullDown(world.row(), 150, { hold: true });
    expect(pulledDistance(world.scroller())).toBe(75.9);
    expect(mark()).not.toBeNull();
    letGo();
  });

  it("announces that mail is up to date without adding a button above the rows", () => {
    const world = listWorld();
    pullDown(world.row(), 150);
    act(() => world.ground.finish({ key: "pullCurrent" }));
    const list = within(world.scroller());
    expect(list.getByRole("status").textContent).toBe("Up to date");
    expect(list.queryByRole("button", { name: "Up to date" })).toBeNull();
    expect(pulledDistance(world.scroller())).toBe(0);
  });

  it.each([
    [{ key: "pullPaused" }, "Not now, checking resumes by itself"],
    [{ key: "pullPending" }, "Checking continues"],
    [{ key: "pullMailboxFailed", mailboxId: "mailbox" }, "Couldn’t check · Open Mailboxes"],
  ] as const)("keeps an action for an incomplete check", (result, name) => {
    const world = listWorld();
    pullDown(world.row(), 150);
    act(() => world.ground.finish(result));
    const button = within(world.scroller()).getByRole("button", { name });
    expect(button).toBeTruthy();
    if (result.key !== "pullMailboxFailed") {
      fireEvent.pointerDown(button);
      fireEvent.click(button);
      expect(world.ground.pulls).toBe(2);
    }
  });

  it("starts no second pull while the first runs, and keeps holding for the one that runs", () => {
    const world = listWorld();
    pullDown(world.row(), 150);
    act(() => {});
    pullDown(world.row(), 150);
    act(() => {});
    expect(world.ground.pulls).toBe(1);
    expect(pulledDistance(world.scroller())).toBe(PULL_HOLD);
    act(() => world.ground.finish());
    expect(pulledDistance(world.scroller())).toBe(0);
    pullDown(world.row(), 150);
    expect(world.ground.pulls).toBe(2);
  });

  it("a release while a pull pressed elsewhere runs starts nothing, and holds the mark for that pull", () => {
    const world = listWorld();
    act(() => world.ground.start());
    expect(pulledDistance(world.scroller()), "a pull from the rail opens no room by itself").toBe(0);
    pullDown(world.row(), 150);
    act(() => {});
    expect(world.ground.pulls).toBe(0);
    expect(pulledDistance(world.scroller())).toBe(PULL_HOLD);
    act(() => world.ground.finish());
    expect(pulledDistance(world.scroller())).toBe(0);
  });

  it("holds nothing for a release whose pull was over at once, nor for a later pull from elsewhere", () => {
    const world = listWorld("phone", true);
    pullDown(world.row(), 150);
    act(() => {});
    expect(world.ground.pulls).toBe(1);
    expect(pulledDistance(world.scroller())).toBe(0);
    act(() => world.ground.start());
    expect(pulledDistance(world.scroller())).toBe(0);
  });

  it("never holds longer than the cap, though the pull still runs", () => {
    vi.useFakeTimers();
    const world = listWorld();
    pullDown(world.row(), 150);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(pulledDistance(world.scroller())).toBe(PULL_HOLD);
    act(() => {
      vi.advanceTimersByTime(PULL_HOLD_CAP_MS);
    });
    expect(pulledDistance(world.scroller())).toBe(0);
    expect(world.ground.pulls).toBe(1);
  });

  it("does not pull short of the mark, or from below the top", () => {
    const world = listWorld();
    pullDown(world.row(), 120);
    Object.defineProperty(world.scroller(), "scrollTop", { value: 10, configurable: true });
    pullDown(world.row(), 150);
    expect(world.ground.pulls).toBe(0);
  });

  it("leaves a list control's gesture alone", () => {
    const world = listWorld();
    pullDown(document.querySelector(".pl-scroll button")!, 150);
    expect(world.ground.pulls).toBe(0);
  });

  it("follows a finger that retreats to the top and releases without refreshing", () => {
    const world = listWorld();
    const release = pullDown(world.row(), 150, { hold: true });
    fireEvent.touchMove(world.row(), { touches: [{ clientX: 100, clientY: 192, identifier: 1 }] });
    expect(pulledDistance(world.scroller())).toBe(0);
    expect(world.scroller().hasAttribute("data-pull-direct")).toBe(true);
    release();
    expect(world.ground.pulls).toBe(0);
  });

  it("does not pull in a two-column touch layout", () => {
    const world = listWorld("fold");
    expect(room()).toBeNull();
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
