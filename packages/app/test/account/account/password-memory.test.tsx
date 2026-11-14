/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePassword } from "../../../src/account/account/use-password.js";
import { changed, FACTOR, fakePasswordDoor, SIGN_IN, type ChangeAnswer } from "./fake-door.js";

/**
 * THE TYPED VALUES ARE DROPPED, not only never sent again. The group's machine already refuses a factor that comes
 * after Cancel, after a discard, after a refusal or after the change landed, so over it a copy the hook kept would
 * never be seen. Here the machine is stood in for by a faulty one, which sends the change again for ANY verified
 * factor: whatever the hook still holds is then what leaves. Nothing may.
 */
vi.mock("../../../src/account/gated.js", async (original) => {
  const real = await original<typeof import("../../../src/account/gated.js")>();
  const faulty = (state: { readonly at: string }, event: { readonly kind: string }): unknown => {
    if (event.kind === "verified" && state.at !== "asking") {
      const run = { act: "change", afterFactor: true };
      return { state: { at: "trying", ...run, nothingRan: false }, run };
    }
    return (real.gatedStep as (state: unknown, event: unknown) => unknown)(state, event);
  };
  return { ...real, gatedStep: faulty as unknown as typeof real.gatedStep };
});

afterEach(cleanup);

const CURRENT = "kestrel-over-the-quarry-41";
const NEXT = "nine-lamps-in-a-wet-harbour";
const settled = (press: () => void) =>
  act(async () => {
    press();
  });

/** A change pressed and parked behind the factor, with the dialog's answers in hand. */
async function parked(after: readonly ChangeAnswer[]) {
  const door = fakePasswordDoor([FACTOR, ...after, changed(9), changed(9)]);
  const { result } = renderHook(() => usePassword(door));
  await settled(() => result.current.change({ current: CURRENT, next: NEXT, again: NEXT }));
  return { door, result, ask: result.current.ask! };
}

describe("what the hook keeps of the two typed values", () => {
  it("CONTROL: while the factor is asked it keeps them, and the faulty machine sends them", async () => {
    const { door, ask } = await parked([]);
    await settled(() => ask.onVerified());
    expect(door.sent()).toEqual([
      [CURRENT, NEXT],
      [CURRENT, NEXT],
    ]);
  });

  it("nothing after Cancel", async () => {
    const { door, ask } = await parked([]);
    await settled(() => ask.onCancel());
    await settled(() => ask.onVerified());
    expect(door.sent()).toHaveLength(1);
  });

  it("nothing after a factor that was thrown away", async () => {
    const { door, ask } = await parked([]);
    await settled(() => ask.onDiscarded());
    await settled(() => ask.onVerified());
    expect(door.sent()).toHaveLength(1);
  });

  for (const refusal of [
    { ok: false, word: "wrong_current" },
    { ok: false, word: "locked", minutes: 3 },
    { ok: false, word: "slowed" },
    { ok: false, word: "conflict" },
    { ok: false, word: "refused" },
    { ok: false, word: "said", said: "You are offline." },
    SIGN_IN,
    FACTOR,
  ] as const) {
    it(`nothing after the refusal "${refusal.word}"`, async () => {
      const { door, ask } = await parked([refusal]);
      await settled(() => ask.onVerified());
      expect(door.sent()).toHaveLength(2);
      await settled(() => ask.onVerified());
      expect(door.sent()).toHaveLength(2);
    });
  }

  it("nothing after the change landed", async () => {
    const { door, result, ask } = await parked([changed(1)]);
    await settled(() => ask.onVerified());
    expect(result.current.changed).toEqual({ ended: 1 });
    await settled(() => ask.onVerified());
    expect(door.sent()).toHaveLength(2);
  });
});
