/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { wideWindow } from "../ohbox/setup.js";
import { at, finger, msg, pointer, touchWorld } from "./touch-world.js";

/*
 * A ROW UNDER A FINGER. Right past 76 presses the read slot as the row's menu says it (Done on an unread row, Mark
 * unread on a read one), left presses Later; each is the menu item's own call, once. A short release, a diagonal, a
 * cancelled finger and a mouse press nothing, and the click that closes a swipe opens no letter.
 */

beforeEach(wideWindow);
afterEach(cleanup);

const letters = () => ({
  newForYou: [msg({ id: "a", subject: "Kiln", date: at(10) })],
  previouslySeen: [msg({ id: "r", subject: "Glaze", unread: false, date: at(6) })],
});
const rowOf = (name: string) => screen.getByRole("option", { name });

describe("a swipe on an Ohbox row", () => {
  it("presses Done once on an unread row past 76, and nothing released at 75", () => {
    const world = touchWorld(letters());
    finger(rowOf("a: Kiln")).move(20, 0).move(75, 0).up();
    expect(world.said.marked).toEqual([]);
    finger(rowOf("a: Kiln")).move(20, 0).move(80, 2).up();
    expect(world.said.marked).toEqual([{ ids: ["a"], unread: false }]);
    expect(world.said.opened, "the click closing the swipe opened the letter").toEqual([]);
  });

  it("presses Later to the left, and Mark unread to the right of a read row", () => {
    const world = touchWorld(letters());
    finger(rowOf("a: Kiln")).move(-20, 0).move(-90, 0).up();
    expect(world.said.acted).toEqual([["later", "a"]]);
    finger(rowOf("r: Glaze")).move(20, 0).move(100, 0).up();
    expect(world.said.marked).toEqual([{ ids: ["r"], unread: true }]);
  });

  it("is the very call the row's menu makes", () => {
    const swiped = touchWorld(letters());
    finger(rowOf("a: Kiln")).move(-20, 0).move(-90, 0).up();
    finger(rowOf("a: Kiln")).move(20, 0).move(90, 0).up();
    const bySwipe = { acted: swiped.said.acted, marked: swiped.said.marked };
    cleanup();
    const pressed = touchWorld(letters());
    fireEvent.contextMenu(rowOf("a: Kiln"), { clientX: 30, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Later/ }));
    fireEvent.contextMenu(rowOf("a: Kiln"), { clientX: 30, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Done/ }));
    expect({ acted: pressed.said.acted, marked: pressed.said.marked }).toEqual(bySwipe);
  });

  it("never takes a diagonal: the list scrolls and nothing is pressed", () => {
    const world = touchWorld(letters());
    finger(rowOf("a: Kiln")).move(5, 8).move(10, 16).move(20, 32).move(60, 96).up();
    expect(world.said.marked).toEqual([]);
    expect(world.said.acted).toEqual([]);
    expect(rowOf("a: Kiln").style.transform).toBe("");
  });

  it("presses nothing when the system takes the finger, and puts the row back", () => {
    const world = touchWorld(letters());
    const f = finger(rowOf("a: Kiln")).move(20, 0).move(100, 0);
    expect(rowOf("a: Kiln").style.transform, "the row follows the finger").not.toBe("");
    f.cancel();
    expect(world.said.marked).toEqual([]);
    expect(rowOf("a: Kiln").style.transform).toBe("");
  });

  it("presses nothing when a second finger lands mid-swipe, and puts the row back", () => {
    const world = touchWorld(letters());
    const f = finger(rowOf("a: Kiln")).move(20, 0).move(100, 0);
    expect(rowOf("a: Kiln").style.transform).not.toBe("");
    act(() => {
      world.scroller().dispatchEvent(pointer("pointerdown", { x: 50, y: 50 }, "touch", 2));
    });
    f.up();
    act(() => {
      world.scroller().dispatchEvent(pointer("pointerup", { x: 50, y: 50 }, "touch", 2));
    });
    expect(world.said.marked).toEqual([]);
    expect(world.said.acted).toEqual([]);
    expect(rowOf("a: Kiln").style.transform, "row left drawn after the second finger").toBe("");
    expect(document.querySelector(".oh-row-back")?.hasAttribute("data-armed") ?? false).toBe(false);
  });

  it("eats only its own release's click: a screen reader's activate and Enter after a swipe both act", async () => {
    const world = touchWorld(letters());
    const swipeWithNoClick = () => {
      finger(rowOf("a: Kiln")).move(-20, 0).move(-100, 0);
      act(() => {
        rowOf("a: Kiln").dispatchEvent(pointer("pointerup", { x: 0, y: 300 }));
      });
    };
    const aFrame = () =>
      act(async () => {
        await new Promise((done) => requestAnimationFrame(() => done(undefined)));
      });
    swipeWithNoClick();
    expect(world.said.acted).toEqual([["later", "a"]]);
    await aFrame();
    fireEvent.click(rowOf("r: Glaze"));
    expect(world.said.opened, "a screen reader's activate after a swipe").toContain("r");
    swipeWithNoClick();
    await aFrame();
    rowOf("a: Kiln").focus();
    fireEvent.keyDown(rowOf("a: Kiln"), { key: "Enter" });
    fireEvent.click(rowOf("a: Kiln"));
    expect(world.said.opened, "Enter on a row after a swipe").toContain("a");
  });

  it("opens the letter on a plain tap, as before", () => {
    const world = touchWorld(letters());
    finger(rowOf("a: Kiln")).up();
    expect(world.said.opened).toContain("a");
  });

  it("starts no swipe while rows are picked, or from the row's Done", () => {
    const world = touchWorld(letters());
    const done = within(rowOf("a: Kiln").parentElement!).getByRole("button", { name: "Done" });
    finger(done).move(20, 0).move(100, 0).up();
    expect(world.said.acted).toEqual([]);
    expect(world.said.marked).toEqual([{ ids: ["a"], unread: false }]);
    fireEvent.contextMenu(rowOf("r: Glaze"), { clientX: 30, clientY: 40 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Select/ }));
    finger(rowOf("a: Kiln")).move(-20, 0).move(-100, 0).up();
    expect(world.said.acted).toEqual([]);
  });

  it("starts no swipe from a press inside the row (its time, where a press turns every time)", () => {
    const world = touchWorld(letters(), { side: { flipTime: () => undefined } });
    const time = within(rowOf("r: Glaze")).getByText("09:00");
    finger(time).move(-20, 0).move(-100, 0).up();
    expect(world.said.acted).toEqual([]);
  });

  it("draws the row by the phone's travel and arms it past 76", () => {
    touchWorld(letters());
    const f = finger(rowOf("a: Kiln")).move(20, 0).move(60, 0);
    expect(rowOf("a: Kiln").style.transform).toBe("translateX(60px)");
    f.move(112, 0);
    expect(document.querySelector(".oh-row-back")?.hasAttribute("data-armed")).toBe(true);
    f.up();
  });

  it("is no swipe under a mouse: the row has no slot and keeps its index", () => {
    const world = touchWorld(letters(), { room: "desktop" });
    const read = rowOf("r: Glaze");
    expect(
      read.parentElement?.classList.contains("oh-row-slot"),
      "a read row has no verbs to stand beside",
    ).toBe(false);
    expect(read.hasAttribute("data-index")).toBe(true);
    expect(world.scroller().hasAttribute("data-touch-list")).toBe(false);
    finger(rowOf("a: Kiln"), "mouse").move(20, 0).move(100, 0).up();
    expect(document.querySelector(".oh-row-back")).toBeNull();
    expect(world.said.marked).toEqual([]);
  });

  it("marks the list under a finger, so a hold selects no text", () => {
    const world = touchWorld(letters());
    expect(world.scroller().hasAttribute("data-touch-list")).toBe(true);
  });
});
