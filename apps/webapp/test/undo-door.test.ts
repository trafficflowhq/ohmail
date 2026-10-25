import { describe, expect, it } from "vitest";
import type { ToastOptions } from "@ohmail/ui";
import { createUndoDoor } from "../app/shell/undo-door";

/**
 * THE ONE UNDO DOOR — the button and `z` press one consume-once take. Driven with
 * a recording host and a hand clock; `key-does-what-its-button-does.test.tsx` drives it through
 * the shell over every held press.
 */
function rig() {
  let clock = 1_000;
  const shown: Array<{ message: string; options?: ToastOptions }> = [];
  const door = createUndoDoor((message, options) => { shown.push({ message, options }); }, () => clock);
  return { door, shown, advance: (ms: number) => { clock += ms; }, button: (i: number) => shown[i]!.options!.onAction!() };
}

describe("the undo door", () => {
  it("z takes the live offer once, and the button after it takes nothing", () => {
    const { door, button } = rig();
    let taken = 0;
    door.toast("Held.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken++; } });
    expect(door.press()).toBe(true);
    button(0);
    expect(door.press()).toBe(false);
    expect(taken).toBe(1);
  });

  it("the button takes it once, and z after it takes nothing", () => {
    const { door, button } = rig();
    let taken = 0;
    door.toast("Held.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken++; } });
    button(0);
    expect(door.press()).toBe(false);
    expect(taken).toBe(1);
  });

  it("taking the offer withdraws its capsule", () => {
    const { door, shown } = rig();
    door.toast("Held.", { action: "Undo", duration: 8000, undo: true, onAction: () => {} });
    const signal = shown[0]!.options!.signal!;
    expect(signal.aborted).toBe(false);
    door.press();
    expect(signal.aborted).toBe(true);
  });

  it("the newest offer holds the door", () => {
    const { door } = rig();
    const taken: string[] = [];
    door.toast("First.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken.push("first"); } });
    door.toast("Second.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken.push("second"); } });
    door.press();
    expect(taken).toEqual(["second"]);
  });

  it("the door closes with the offer's duration, and with its caller's signal", () => {
    const { door, advance } = rig();
    door.toast("Held.", { action: "Undo", duration: 8000, undo: true, onAction: () => {} });
    advance(8001);
    expect(door.press()).toBe(false);
    const ends = new AbortController();
    door.toast("Held.", { action: "Undo", duration: 8000, undo: true, onAction: () => {}, signal: ends.signal });
    ends.abort();
    expect(door.press()).toBe(false);
  });

  it("z before the offer is raised takes it the moment it is: the press arms the undo, the toast only shows it", () => {
    const { door, shown } = rig();
    let taken = 0;
    const claim = door.expect();
    expect(door.press()).toBe(true);
    door.toast("Parked.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken++; }, claim });
    expect(taken).toBe(1);
    expect(shown).toEqual([]);
    expect(door.press()).toBe(false);
  });

  it("an offer raised with no z waiting stands as before, and a press that offers nothing leaves z with nothing", () => {
    const { door } = rig();
    let taken = 0;
    const claim = door.expect();
    door.toast("Parked.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken++; }, claim });
    expect(taken).toBe(0);
    expect(door.press()).toBe(true);
    expect(taken).toBe(1);
    door.drop(door.expect());
    expect(door.press()).toBe(false);
  });

  it("an offer raised with no claim while an earlier press is unanswered is the newer press: z takes it", () => {
    const { door, shown } = rig();
    const taken: string[] = [];
    const claim = door.expect();
    door.toast("Deleted.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken.push("delete"); } });
    expect(door.press()).toBe(true);
    expect(taken).toEqual(["delete"]);
    expect(claim.asked).toBe(false);
    door.toast("Parked.", { action: "Undo", duration: 8000, undo: true, onAction: () => { taken.push("park"); }, claim });
    expect(taken).toEqual(["delete"]);
    expect(shown.map((s) => s.message)).toEqual(["Deleted.", "Parked."]);
  });

  it("an action that is not an Undo passes through and arms nothing (the control)", () => {
    const { door, shown } = rig();
    let pressed = 0;
    door.toast("Your rule keeps 3 there.", { action: "Remove the rule", duration: 8000, onAction: () => { pressed++; } });
    door.toast("Plain.");
    expect(door.press()).toBe(false);
    expect(pressed).toBe(0);
    expect(shown.map((s) => s.message)).toEqual(["Your rule keeps 3 there.", "Plain."]);
    expect(shown[1]!.options).toBeUndefined();
  });
});
