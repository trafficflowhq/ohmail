/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_START, storageStep, type StorageDoor } from "../../../src/account/storage/model.js";
import { useStorage } from "../../../src/account/storage/use-storage.js";
import { fakeStorageDoor, held, someFigures, THROWS, type ChangeAnswer } from "./fake-door.js";

afterEach(cleanup);

const FACTOR: ChangeAnswer = { ok: false, word: "factor" };
const LEFT: ChangeAnswer = { ok: true, value: "left" };

function mounted(door: StorageDoor, strict = false) {
  // Strict mode from the root: under a wrapper it would replay no effect.
  return renderHook(() => useStorage(door), { reactStrictMode: strict });
}
/** A press, and every answer it brings taken in. */
const settled = (press: () => void) =>
  act(async () => {
    press();
  });

describe("the storage mails' switch", () => {
  it("reads the figures' word before any press", () => {
    const { result } = mounted(fakeStorageDoor({ figures: someFigures({ mail: false }) }));
    expect(result.current.mail).toEqual({ on: false, busy: false, failed: false });
  });

  it("shows what a press writes at once, and holds what the server took over the figures' word", async () => {
    const write = held<boolean>();
    const door = fakeStorageDoor({ figures: someFigures({ mail: true }), writes: [write.promise] });
    const { result } = mounted(door);
    act(() => result.current.setMail(false));
    expect(result.current.mail).toEqual({ on: false, busy: true, failed: false });
    await settled(() => write.settle(true));
    expect(door.written()).toEqual([false]);
    // The access answer read afterwards may still say on: what was written holds.
    act(() => door.show(someFigures({ mail: true })));
    expect(result.current.mail).toEqual({ on: false, busy: false, failed: false });
  });

  it("goes back where it stood and says so when the write is refused", async () => {
    const door = fakeStorageDoor({ figures: someFigures({ mail: true }), writes: [false] });
    const { result } = mounted(door);
    await settled(() => result.current.setMail(false));
    expect(result.current.mail).toEqual({ on: true, busy: false, failed: true });
    expect(door.written()).toEqual([false]);
  });

  it("writes one value at a time: a press while a write is on its way writes nothing", async () => {
    const write = held<boolean>();
    const door = fakeStorageDoor({ figures: someFigures(), writes: [write.promise, true] });
    const { result } = mounted(door);
    act(() => result.current.setMail(false));
    act(() => result.current.setMail(true));
    await settled(() => write.settle(true));
    expect(door.written()).toEqual([false]);
    expect(result.current.mail.on).toBe(false);
  });

  it("a write the door could not answer is one that was refused", async () => {
    const door = fakeStorageDoor({ figures: someFigures({ mail: true }), writes: [THROWS] });
    const { result } = mounted(door);
    await settled(() => result.current.setMail(false));
    expect(result.current.mail).toEqual({ on: true, busy: false, failed: true });
  });
});

describe("the plan's change, guarded by the factor", () => {
  it("is tried first: drawing the pane asks nothing, and the press asks once", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), changes: [LEFT] });
    const { result } = mounted(door);
    expect(door.changed()).toBe(0);
    await settled(() => result.current.change());
    expect(door.changed()).toBe(1);
    expect(result.current.ask).toBeNull();
    expect(result.current.refusal).toBeNull();
  });

  it("asks the factor only on the server's refusal, and sends nothing more before it verifies", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), changes: [FACTOR, LEFT] });
    const { result } = mounted(door);
    await settled(() => result.current.change());
    expect(result.current.ask).not.toBeNull();
    expect(result.current.changing).toBe(true);
    // A second press while the factor is asked is not taken.
    await settled(() => result.current.change());
    expect(door.changed()).toBe(1);
    await settled(() => result.current.ask!.onVerified());
    expect(door.changed()).toBe(2);
    expect(result.current.ask).toBeNull();
    expect(result.current.changing).toBe(false);
  });

  it("the verified factor sends the parked change once, however often it is said", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), changes: [FACTOR, LEFT] });
    const { result } = mounted(door);
    await settled(() => result.current.change());
    const ask = result.current.ask!;
    await settled(() => {
      ask.onVerified();
      ask.onVerified();
    });
    expect(door.changed()).toBe(2);
  });

  it("says a second refusal after the factor, and never asks again", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), changes: [FACTOR, FACTOR] });
    const { result } = mounted(door);
    await settled(() => result.current.change());
    await settled(() => result.current.ask!.onVerified());
    expect(door.changed()).toBe(2);
    expect(result.current.ask).toBeNull();
    expect(result.current.refusal).toEqual({ word: "sign_in" });
  });

  it("Cancel drops the parked change; a factor after Cancel says nothing ran and sends nothing", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), changes: [FACTOR, LEFT] });
    const { result } = mounted(door);
    await settled(() => result.current.change());
    const ask = result.current.ask!;
    await settled(() => ask.onCancel());
    expect(result.current.ask).toBeNull();
    expect(result.current.nothingRan).toBe(false);
    await settled(() => ask.onDiscarded());
    await settled(() => ask.onVerified());
    expect(result.current.nothingRan).toBe(true);
    expect(door.changed()).toBe(1);
  });

  it("says an address that is not confirmed apart from a page that could not be opened", async () => {
    const door = fakeStorageDoor({
      figures: someFigures(),
      changes: [
        { ok: false, word: "unverified" },
        { ok: false, word: "failed" },
      ],
    });
    const { result } = mounted(door);
    await settled(() => result.current.change());
    expect(result.current.refusal).toEqual({ word: "unverified" });
    await settled(() => result.current.change());
    expect(result.current.refusal).toEqual({ word: "failed" });
    expect(door.changed()).toBe(2);
  });

  it("a change the door could not answer did not leave", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), changes: [THROWS] });
    const { result } = mounted(door);
    await settled(() => result.current.change());
    expect(result.current.refusal).toEqual({ word: "failed" });
  });

  it("a pane left while the factor is asked sends nothing afterwards", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), changes: [FACTOR, LEFT] });
    const { result, unmount } = mounted(door);
    await settled(() => result.current.change());
    const ask = result.current.ask!;
    unmount();
    await act(async () => ask.onVerified());
    expect(door.changed()).toBe(1);
  });

  it("a press on a pane that was left writes nothing and changes nothing", async () => {
    const door = fakeStorageDoor({ figures: someFigures(), writes: [true], changes: [LEFT] });
    const { result, unmount } = mounted(door);
    const { setMail, change } = result.current;
    unmount();
    await settled(() => {
      setMail(false);
      change();
    });
    expect(door.written()).toEqual([]);
    expect(door.changed()).toBe(0);
  });

  it("works where the tree is mounted twice over: the guard is armed in the effect", async () => {
    const door = fakeStorageDoor({
      figures: someFigures({ mail: true }),
      changes: [FACTOR, LEFT],
      writes: [true],
    });
    const { result } = mounted(door, true);
    await settled(() => result.current.setMail(false));
    expect(door.written()).toEqual([false]);
    await settled(() => result.current.change());
    await settled(() => result.current.ask!.onVerified());
    expect(door.changed()).toBe(2);
  });
});

describe("the figures", () => {
  it("follow the access answer as it changes, and draw nothing where it carries no storage block", () => {
    const door = fakeStorageDoor({ figures: null });
    const { result } = mounted(door);
    expect(result.current.figures).toBeNull();
    act(() => door.show(someFigures({ used: "4.6 GB" })));
    expect(result.current.figures?.used).toBe("4.6 GB");
  });
});

describe("the step", () => {
  it("takes no second press of the switch while a write is on its way", () => {
    const pressed = storageStep(STORAGE_START, { kind: "mailPressed", on: false }).state;
    expect(storageStep(pressed, { kind: "mailPressed", on: true }).state).toBe(pressed);
  });

  it("hands back the change to send exactly once per press, and none for the switch", () => {
    expect(storageStep(STORAGE_START, { kind: "mailPressed", on: true }).run).toBeNull();
    const tried = storageStep(STORAGE_START, { kind: "try", act: "change" });
    expect(tried.run).toEqual({ act: "change", afterFactor: false });
    expect(storageStep(tried.state, { kind: "try", act: "change" }).run).toBeNull();
  });
});
