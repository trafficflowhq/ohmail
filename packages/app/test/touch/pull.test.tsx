/** @vitest-environment jsdom */
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NONE } from "../../src/host/index.js";
import { wideWindow } from "../ohbox/setup.js";
import { at, msg, pullDown, touchWorld } from "./touch-world.js";

/*
 * PULL NEW MAIL BY FINGER: the list pulled down at its top presses the list's own pull, the very binding its menu
 * item presses, and only that (the host's engine here throws on any read). Once per pull; never while the pull is
 * under way, never from below the top, never short of the mark, and not at all where the host has no pull.
 */

beforeEach(wideWindow);
afterEach(cleanup);

const letters = () => ({ newForYou: [msg({ id: "a", subject: "Kiln", date: at(10) })] });
const row = () => screen.getByRole("option", { name: "a: Kiln" });

describe("a pull at the Ohbox's top", () => {
  it("pulls once, from 150 down", () => {
    const world = touchWorld(letters());
    pullDown(row(), 150);
    expect(world.said.pulled).toBe(1);
    expect(world.said.opened).toEqual([]);
  });

  it("opens a room while the finger is down, and closes it when let go", () => {
    const world = touchWorld(letters());
    const room = () => document.querySelector<HTMLElement>(".tc-pull")!;
    expect(room().style.height).toBe("0px");
    const letGo = pullDown(row(), 1000, { hold: true, cancel: true });
    expect(room().style.height, "drawn down at most 120").toBe("120px");
    letGo();
    expect(room().style.height).toBe("0px");
    expect(world.said.pulled).toBe(0);
    pullDown(row(), 150);
    expect(world.said.pulled).toBe(1);
  });

  it("closes the room and pulls nothing when a second finger lands during a pull", () => {
    const world = touchWorld(letters());
    const room = () => document.querySelector<HTMLElement>(".tc-pull")!;
    pullDown(row(), 200, { hold: true });
    expect(room().style.height).not.toBe("0px");
    act(() => {
      const two = new Event("touchstart", { bubbles: true, cancelable: true });
      Object.defineProperty(two, "touches", {
        value: [
          { clientX: 100, clientY: 400, identifier: 1 },
          { clientX: 200, clientY: 400, identifier: 2 },
        ],
      });
      row().dispatchEvent(two);
    });
    act(() => {
      const end = new Event("touchend", { bubbles: true, cancelable: true });
      Object.defineProperty(end, "touches", { value: [] });
      row().dispatchEvent(end);
    });
    expect(world.said.pulled).toBe(0);
    expect(room().style.height, "the pull's room left open").toBe("0px");
  });

  it("does not pull from below the list's top", () => {
    const world = touchWorld(letters());
    /* jsdom lays nothing out: the scroller says where it stands. */
    Object.defineProperty(world.scroller(), "scrollTop", { value: 10, configurable: true });
    pullDown(row(), 150);
    expect(world.said.pulled).toBe(0);
  });

  it("does not pull short of the mark, or when the system takes the finger", () => {
    const world = touchWorld(letters());
    pullDown(row(), 120);
    pullDown(row(), 200, { cancel: true });
    expect(world.said.pulled).toBe(0);
  });

  it("does not pull a second time while the first is under way", () => {
    const world = touchWorld(letters());
    world.again({}, { pull: { busy: true, run: () => (world.said.pulled += 1) } });
    pullDown(row(), 150);
    expect(world.said.pulled).toBe(0);
  });

  it("has no pull and no room where the host has none", () => {
    const world = touchWorld(letters(), { side: { pull: NONE } });
    expect(document.querySelector(".tc-pull")).toBeNull();
    pullDown(row(), 150);
    expect(world.said.pulled).toBe(0);
  });

  it("keeps the rows the window drew while the room grows", () => {
    touchWorld(letters());
    const before = [...document.querySelectorAll("[data-index]")].map((n) => n.getAttribute("data-index"));
    pullDown(row(), 100, { steps: 3, cancel: true });
    expect([...document.querySelectorAll("[data-index]")].map((n) => n.getAttribute("data-index"))).toEqual(
      before,
    );
  });

  it("is no pull under a mouse", () => {
    const world = touchWorld(letters(), { room: "desktop" });
    expect(document.querySelector(".tc-pull")).toBeNull();
    pullDown(row(), 150);
    expect(world.said.pulled).toBe(0);
  });
});
