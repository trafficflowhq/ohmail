/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { LANDING_REST_MS, useReaderVisit } from "../../src/reading/reader-seen.js";

/**
 * A LANDING WHOSE ADDRESS ARRIVES A FRAME LATER IS STILL A LANDING. On the web the address a step key pushes is
 * announced a frame after the key (the browser's own change), so the commit right after `land(id)` still shows the
 * letter before. The record `land` named must live through that commit: else the letter, once shown, opens as a
 * letter read (its embedded pictures asked at once, its rest not a landing's) instead of one passed over.
 */

const letter = (id: string) => ({ id, unread: true }) as EngineMessage;
afterEach(cleanup);

describe("the visit of a list's reader: a step key's landing", () => {
  it("keeps the landed letter's record while the address still names the letter before, and rests it when shown", () => {
    const { result, rerender } = renderHook(
      ({ shown }: { shown: EngineMessage | null }) => useReaderVisit({ shown, markSeen: () => true }),
      { initialProps: { shown: letter("m1") as EngineMessage | null } },
    );
    // The key lands on m2; the commit that follows still shows m1 (the address has not changed yet).
    act(() => result.current.land("m2"));
    rerender({ shown: letter("m1") });
    // A frame later the address names m2.
    rerender({ shown: letter("m2") });
    const wiring = result.current.wiring;
    expect(wiring?.restMs, "a landing rests before it is read").toBe(LANDING_REST_MS);
    expect(wiring?.previewing, "a landing not rested on is a preview: no picture is asked").toBe(true);
  });

  it("drops a pending landing when the address names a third letter", () => {
    const { result, rerender } = renderHook(
      ({ shown }: { shown: EngineMessage | null }) => useReaderVisit({ shown, markSeen: () => true }),
      { initialProps: { shown: letter("m1") as EngineMessage | null } },
    );
    act(() => result.current.land("m2"));
    rerender({ shown: letter("m1") });
    rerender({ shown: letter("m3") });
    rerender({ shown: letter("m2") });
    expect(result.current.wiring?.restMs).toBeUndefined();
    expect(result.current.wiring?.previewing).toBeUndefined();
  });

  it("a new landing replaces the pending one before either address arrives", () => {
    const { result, rerender } = renderHook(
      ({ shown }: { shown: EngineMessage | null }) => useReaderVisit({ shown, markSeen: () => true }),
      { initialProps: { shown: letter("m1") as EngineMessage | null } },
    );
    act(() => result.current.land("m2"));
    act(() => result.current.land("m3"));
    rerender({ shown: letter("m3") });
    expect(result.current.wiring?.restMs).toBe(LANDING_REST_MS);
    rerender({ shown: letter("m2") });
    expect(result.current.wiring?.restMs).toBeUndefined();
  });

  it("a letter shown without a landing (an open) is not held as a landing", () => {
    const { result, rerender } = renderHook(
      ({ shown }: { shown: EngineMessage | null }) => useReaderVisit({ shown, markSeen: () => true }),
      { initialProps: { shown: letter("m1") as EngineMessage | null } },
    );
    rerender({ shown: letter("m2") });
    expect(result.current.wiring?.restMs).toBeUndefined();
    expect(result.current.wiring?.previewing).toBeUndefined();
  });
});
