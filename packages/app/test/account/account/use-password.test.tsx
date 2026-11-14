/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_LENGTH,
  MIN_LENGTH,
  passwordCheck,
  type PasswordDoor,
  type PasswordTyped,
} from "../../../src/account/account/password.js";
import { usePassword } from "../../../src/account/account/use-password.js";
import { changed, FACTOR, fakePasswordDoor, held, SIGN_IN, THROWS, type ChangeAnswer } from "./fake-door.js";

afterEach(cleanup);

/* What a person types. Each is unlike the other and unlike any sentence, so a kept copy is found by its letters. */
const CURRENT = "kestrel-over-the-quarry-41";
const NEXT = "nine-lamps-in-a-wet-harbour";
const typed = (current = CURRENT, next = NEXT, again = next): PasswordTyped => ({ current, next, again });
/** One character outside the basic plane: two code units, one code point. */
const ASTRAL = "\u{1F511}";

function mounted(door: PasswordDoor, strict = false) {
  // Strict mode from the root: under a wrapper it would replay no effect.
  return renderHook(() => usePassword(door), { reactStrictMode: strict });
}
/** A press, and every answer it brings taken in. */
const settled = (press: () => void) =>
  act(async () => {
    press();
  });
/** Everything the model holds as data: what a typed value would have to be in to be kept. */
const kept = (model: unknown): string => JSON.stringify(model);

describe("what was typed is checked before anything is sent", () => {
  it("in the server's order: no current one, two that differ, the length, the same again", () => {
    expect(passwordCheck(typed("", "short", "other"))).toBe("needCurrent");
    expect(passwordCheck(typed(CURRENT, "short", "other"))).toBe("mismatch");
    expect(passwordCheck(typed(CURRENT, "short"))).toBe("tooShort");
    expect(passwordCheck(typed(CURRENT, "x".repeat(MAX_LENGTH + 1)))).toBe("tooLong");
    expect(passwordCheck(typed(CURRENT, CURRENT))).toBe("same");
    expect(passwordCheck(typed())).toBeNull();
  });

  it("counts a new one in characters as a person counts them, at both ends", () => {
    expect(passwordCheck(typed(CURRENT, "x".repeat(MIN_LENGTH - 1)))).toBe("tooShort");
    expect(passwordCheck(typed(CURRENT, "x".repeat(MIN_LENGTH)))).toBeNull();
    expect(passwordCheck(typed(CURRENT, "x".repeat(MAX_LENGTH)))).toBeNull();
    // Outside the basic plane a character is two units of the string and still one character.
    expect(passwordCheck(typed(CURRENT, ASTRAL.repeat(MIN_LENGTH - 1)))).toBe("tooShort");
    expect(passwordCheck(typed(CURRENT, ASTRAL.repeat(MIN_LENGTH)))).toBeNull();
    expect(passwordCheck(typed(CURRENT, ASTRAL.repeat(MAX_LENGTH)))).toBeNull();
    expect(passwordCheck(typed(CURRENT, ASTRAL.repeat(MAX_LENGTH + 1)))).toBe("tooLong");
  });

  it("a check that fails is said and sends nothing", async () => {
    const door = fakePasswordDoor([changed(0)]);
    const { result } = mounted(door);
    for (const [attempt, word] of [
      [typed(""), "needCurrent"],
      [typed(CURRENT, NEXT, `${NEXT}x`), "mismatch"],
      [typed(CURRENT, "too-short"), "tooShort"],
      [typed(CURRENT, CURRENT), "same"],
    ] as const) {
      await settled(() => result.current.change(attempt));
      expect(result.current.refusal).toEqual({ word });
    }
    expect(door.sent()).toEqual([]);
  });
});

describe("the change", () => {
  it("is one request with the two typed values, and says how many other sessions it ended", async () => {
    const door = fakePasswordDoor([changed(2)]);
    const { result } = mounted(door);
    await settled(() => result.current.change(typed()));
    expect(door.sent()).toEqual([[CURRENT, NEXT]]);
    expect(result.current.changed).toEqual({ ended: 2 });
    expect(result.current.refusal).toBeNull();
    expect(result.current.sending).toBe(false);
  });

  it("is off while it is on its way: a second press is not an attempt", async () => {
    const answer = held<ChangeAnswer>();
    const door = fakePasswordDoor([answer.promise, changed(0)]);
    const { result } = mounted(door);
    await settled(() => result.current.change(typed()));
    expect(result.current.sending).toBe(true);
    await settled(() => result.current.change(typed("another-current-one", "another-new-one-entirely")));
    expect(door.sent()).toEqual([[CURRENT, NEXT]]);
    await settled(() => answer.settle(changed(1)));
    expect(result.current.changed).toEqual({ ended: 1 });
  });

  it("says the server's own refusals by their words, a wait with its minutes", async () => {
    const door = fakePasswordDoor([
      { ok: false, word: "wrong_current" },
      { ok: false, word: "locked", minutes: 14 },
      { ok: false, word: "slowed" },
      { ok: false, word: "conflict" },
      { ok: false, word: "refused" },
      SIGN_IN,
      { ok: false, word: "said", said: "You are offline." },
      THROWS,
    ]);
    const { result } = mounted(door);
    const said: unknown[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await settled(() => result.current.change(typed()));
      said.push(result.current.refusal);
      expect(result.current.changed).toBeNull();
      expect(result.current.ask).toBeNull();
    }
    expect(said).toEqual([
      { word: "wrong_current" },
      { word: "locked", minutes: 14 },
      { word: "slowed" },
      { word: "conflict" },
      { word: "refused" },
      { word: "sign_in" },
      { word: "said", said: "You are offline." },
      { word: "refused" },
    ]);
    expect(door.sent()).toHaveLength(8);
  });

  it("the next attempt starts clean: what the last one said or did is no longer said", async () => {
    const door = fakePasswordDoor([changed(3), { ok: false, word: "wrong_current" }]);
    const { result } = mounted(door);
    await settled(() => result.current.change(typed()));
    await settled(() => result.current.change(typed("")));
    expect(result.current.changed).toBeNull();
    expect(result.current.refusal).toEqual({ word: "needCurrent" });
    await settled(() => result.current.change(typed()));
    expect(result.current.refusal).toEqual({ word: "wrong_current" });
  });

  it("works where the tree is mounted twice over", async () => {
    const door = fakePasswordDoor([changed(0)]);
    const { result } = mounted(door, true);
    await settled(() => result.current.change(typed()));
    expect(door.sent()).toEqual([[CURRENT, NEXT]]);
    expect(result.current.changed).toEqual({ ended: 0 });
  });
});

describe("a change the server guards with the factor", () => {
  /** The form mounted, a change pressed, and the server asking for the factor. */
  async function parked(answers: Parameters<typeof fakePasswordDoor>[0]) {
    const door = fakePasswordDoor(answers);
    const hook = mounted(door);
    await settled(() => hook.result.current.change(typed()));
    return { door, ...hook };
  }

  it("is tried first, asks the factor only on the refusal, and sends nothing more before it verifies", async () => {
    const { door, result } = await parked([FACTOR, changed(1)]);
    expect(door.sent()).toHaveLength(1);
    expect(result.current.ask).not.toBeNull();
    expect(result.current.refusal).toBeNull();
    await settled(() => result.current.change(typed("another-current-one", "another-new-one-entirely")));
    expect(door.sent()).toHaveLength(1);
  });

  it("a press while the factor is asked replaces nothing: the factor sends what was parked", async () => {
    const { door, result } = await parked([FACTOR, changed(1)]);
    await settled(() => result.current.change(typed("another-current-one", "another-new-one-entirely")));
    await settled(() => result.current.ask!.onVerified());
    expect(door.sent()).toEqual([
      [CURRENT, NEXT],
      [CURRENT, NEXT],
    ]);
  });

  it("the verified factor sends the same change once, with no further press, however often it is said", async () => {
    const { door, result } = await parked([FACTOR, changed(1)]);
    const ask = result.current.ask!;
    await settled(() => {
      ask.onVerified();
      ask.onVerified();
    });
    expect(door.sent()).toEqual([
      [CURRENT, NEXT],
      [CURRENT, NEXT],
    ]);
    expect(result.current.changed).toEqual({ ended: 1 });
    expect(result.current.ask).toBeNull();
  });

  it("refused again after the factor is the way back in, never a second dialog", async () => {
    const { door, result } = await parked([FACTOR, FACTOR, changed(1)]);
    await settled(() => result.current.ask!.onVerified());
    expect(result.current.refusal).toEqual({ word: "sign_in" });
    expect(result.current.ask).toBeNull();
    expect(door.sent()).toHaveLength(2);
  });

  it("Cancel drops it: a factor said afterwards sends nothing", async () => {
    const { door, result } = await parked([FACTOR, changed(1)]);
    const ask = result.current.ask!;
    await settled(() => ask.onCancel());
    expect(result.current.ask).toBeNull();
    expect(result.current.nothingChanged).toBe(false);
    await settled(() => ask.onVerified());
    expect(door.sent()).toHaveLength(1);
  });

  it("a factor that landed after Cancel says nothing was changed, and nothing was", async () => {
    const { door, result } = await parked([FACTOR, changed(1)]);
    const ask = result.current.ask!;
    await settled(() => ask.onCancel());
    await settled(() => ask.onDiscarded());
    expect(result.current.nothingChanged).toBe(true);
    await settled(() => ask.onVerified());
    expect(door.sent()).toHaveLength(1);
    // The next attempt starts clean.
    await settled(() => result.current.change(typed("")));
    expect(result.current.nothingChanged).toBe(false);
  });

  it("a form left while the factor is asked sends nothing afterwards", async () => {
    const { door, result, unmount } = await parked([FACTOR, changed(1)]);
    const ask = result.current.ask!;
    unmount();
    await settled(() => ask.onVerified());
    expect(door.sent()).toHaveLength(1);
  });
});

describe("where the typed values are", () => {
  it("in no state of the model, from the press to the end", async () => {
    const answer = held<ChangeAnswer>();
    const door = fakePasswordDoor([FACTOR, answer.promise, { ok: false, word: "wrong_current" }]);
    const { result } = mounted(door);
    const seen: string[] = [kept(result.current)];
    await settled(() => result.current.change(typed()));
    seen.push(kept(result.current));
    await settled(() => result.current.ask!.onVerified());
    seen.push(kept(result.current));
    await settled(() => answer.settle(changed(1)));
    seen.push(kept(result.current));
    await settled(() => result.current.change(typed()));
    seen.push(kept(result.current));
    for (const model of seen) {
      expect(model).not.toContain(CURRENT);
      expect(model).not.toContain(NEXT);
    }
  });
});
