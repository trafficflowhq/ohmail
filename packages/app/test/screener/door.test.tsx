/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NONE } from "../../src/host/index.js";
import {
  HeldInvitation,
  ScreenerAbove,
  screenerPlace,
  segmentOf,
  useScreener,
  type HeldInvitationProps,
  type ScreenerBeside,
} from "../../src/screener/index.js";
import { BESIDE, inWords, modelOf, mountPlace, type Asked } from "./screener-world.js";

/**
 * THE SCREENER'S DOOR: the place it registers, the one model above both panes (a pane drawn without it is a
 * mistake, said at once), the rail's count, the place an invitation held in Waiting stands in, and the commit of the
 * undo window the moment the list leaves its place or its section.
 */

let asked: Asked;
beforeEach(() => {
  asked = { flushes: 0 };
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
});
afterEach(cleanup);

describe("the Screener's place", () => {
  it("registers its own two panes: never the reader's column, which would mark a held letter read", () => {
    expect(screenerPlace.id).toBe("screener");
    expect(screenerPlace.body).toBe("screener");
    expect(screenerPlace.rail).toMatchObject({
      group: "screener",
      icon: "screener",
      label: "title",
      keyHint: "g s",
    });
    const panes = screenerPlace.panes;
    expect(panes.kind).toBe("columns");
    if (panes.kind !== "columns") return;
    expect(panes.Reading).not.toBe("reader");
    expect(typeof panes.Reading).toBe("function");
  });

  it("reads its section from the route's word, and anything else is Waiting", () => {
    expect(segmentOf(null)).toBe("waiting");
    expect(segmentOf("screened")).toBe("screened");
    expect(segmentOf("spam")).toBe("spam");
    expect(segmentOf("junk")).toBe("waiting");
  });

  it("is drawn in the real frame under its head, and the empty column says how many wait", () => {
    mountPlace(modelOf(asked, { waitingCount: 3 }));
    const list = screen.getByRole("region", { name: "Messages" });
    expect(within(list).getByText("Screener")).toBeTruthy();
    const reading = screen.getByRole("region", { name: "Reading" });
    expect(reading.textContent).toBe("3 first-time senders waiting");
  });

  it("the rail states no count until the queue has settled, then the waiting count, hot", () => {
    const world = mountPlace(modelOf(asked, { waitingCount: 4, queueSettled: false }));
    const rail = () => screen.getByRole("navigation");
    expect(within(rail()).queryByText("4")).toBeNull();
    world.again(modelOf(asked, { waitingCount: 4 }));
    expect(within(rail()).getByText("4")).toBeTruthy();
    world.again(modelOf(asked, { waitingCount: 0 }));
    expect(within(rail()).queryByText("0")).toBeNull();
  });

  it("a pane drawn with nothing above it throws: no pane makes a model of its own", () => {
    function Lost() {
      useScreener();
      return null;
    }
    expect(() => render(inWords(<Lost />))).toThrow(/nothing above it \(ScreenerAbove\)/);
  });
});

describe("the place an invitation held in the Screener stands in", () => {
  const Invitation = ({ messageId }: HeldInvitationProps) => <p>{`invitation of ${messageId}`}</p>;
  const beside: ScreenerBeside = { ...BESIDE, invitation: Invitation };

  it("draws the calendar's part for a letter of Waiting", () => {
    render(
      inWords(
        <ScreenerAbove model={modelOf(asked)} beside={beside}>
          <HeldInvitation messageId="m1" segment="waiting" />
        </ScreenerAbove>,
      ),
    );
    expect(screen.getByText("invitation of m1")).toBeTruthy();
  });

  it("draws nothing for a letter kept out, and nothing where the shell hands no calendar", () => {
    render(
      inWords(
        <ScreenerAbove model={modelOf(asked)} beside={beside}>
          <HeldInvitation messageId="m1" segment="screened" />
          <HeldInvitation messageId="m2" segment="spam" />
        </ScreenerAbove>,
      ),
    );
    expect(screen.queryByText(/invitation of/)).toBeNull();
    cleanup();
    render(
      inWords(
        <ScreenerAbove model={modelOf(asked)} beside={{ ...BESIDE, invitation: NONE }}>
          <HeldInvitation messageId="m1" segment="waiting" />
        </ScreenerAbove>,
      ),
    );
    expect(screen.queryByText(/invitation of/)).toBeNull();
  });
});

describe("the undo window is committed when the list leaves", () => {
  it("leaving the section commits at once; standing still commits nothing", () => {
    const world = mountPlace(modelOf(asked));
    expect(asked.flushes).toBe(0);
    act(() => world.address.visit("#/screener/screened"));
    expect(asked.flushes).toBe(1);
    act(() => world.address.visit("#/screener/screened"));
    expect(asked.flushes).toBe(1);
  });

  it("leaving the place commits at once", () => {
    const world = mountPlace(modelOf(asked));
    act(() => world.address.visit("#/ohbox"));
    expect(asked.flushes).toBe(1);
  });
});
