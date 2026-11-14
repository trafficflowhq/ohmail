"use client";

/**
 * THE BODY'S ARRIVAL — the one subscription a surface that draws a body by id takes, moved word for word out of the
 * web shell's `body-slice.ts` (which keeps its two chrome doors and imports this). The shell's derivations key on a
 * stamp that bodies do not move, so a surface that draws one must ask here, or it goes on showing the loading
 * marker's snippet (`derived-stamp-census.test.ts` refuses a `bodyOf` call with no subscription, in the old tree and
 * the new). {@link useBodyArrival} subscribes for ONE message; {@link useBodyStamp} for a view that draws many.
 */

import { useCallback, useSyncExternalStore } from "react";
import { useEngineOrNull } from "../engine/index.js";

/** Unsubscribing from nothing — a bare harness mount has no engine, and nothing will arrive. */
const NOTHING_TO_STOP = (): void => {};

/**
 * Re-render this surface when the body of `messageId` lands — and not when anybody else's does.
 *
 * The snapshot is the stored record's IDENTITY, which the mirror replaces only when that
 * message's body is written, purged or overlaid. The value is deliberately not returned: the
 * caller already has `bodyOf`, which merges the record with the message's own field and with the
 * reach-past door's answer, and a second way of asking is a second answer waiting to disagree.
 */
export function useBodyArrival(messageId: string | null): void {
  const engine = useEngineOrNull();
  const subscribe = useCallback(
    (cb: () => void) => (engine === null ? NOTHING_TO_STOP : engine.subscribe(cb)),
    [engine],
  );
  useSyncExternalStore(
    subscribe,
    () => (engine === null || messageId === null ? undefined : engine.read().get("message_body", messageId)),
    () => undefined,
  );
}

/**
 * Re-render this surface when ANY body lands — for a view that draws its bodies in a loop.
 *
 * Returned as a number so a caller may key on it; most simply call it for the subscription. The
 * stamp moves only for `message_body` writes, so an arriving page of mail does not come through
 * here — that is the shell's derived version's business, and this view re-renders for it anyway.
 */
export function useBodyStamp(): number {
  const engine = useEngineOrNull();
  const subscribe = useCallback(
    (cb: () => void) => (engine === null ? NOTHING_TO_STOP : engine.subscribe(cb)),
    [engine],
  );
  return useSyncExternalStore(
    subscribe,
    () => (engine === null ? 0 : engine.read().stampOf("message_body")),
    () => 0,
  );
}
