"use client";

/**
 * THE BODY SLICE — the one part of the mirror the window reads BY ID at the moment it draws, and
 * the only part with a subscription of its own.
 *
 * Everything else the window shows is a whole-mirror derivation: a pile, a partition, a count, a
 * projection. Bodies are not. Nothing lists them; a surface asks for the body of the one message
 * it is drawing, and the answer concerns no other surface. That asymmetry is why they get their
 * own door rather than riding the shell's version — counted against the real shell, ONE body
 * publish re-rendered the whole window and rebuilt twenty whole-mirror passes for a fact none of
 * them reads, and an open publishes three (the loading marker, the answer, the cache trim).
 *
 * With the shell's derivations keyed on {@link useDerivedVersion}, a body landing no longer
 * reaches them — so the surfaces that DO draw a body have to ask for it here, or they would go
 * on showing the snippet the loading marker left. `body-slice-census.test.ts` refuses a file
 * that calls `bodyOf` in a render without one of these hooks: a body that never appears is the
 * kind of failure that renders as its own healthy state.
 *
 * Two hooks, because there are two shapes of consumer:
 *
 *  · {@link useBodyArrival} — a surface drawing ONE message (the reading pane, a conversation
 *    card). It re-renders when THAT message's body record changes and for no other body.
 *  · {@link useBodyStamp} — a surface drawing many in a loop, where a hook per message is not
 *    expressible. It re-renders when any body lands; its rows are memoized on the body's own
 *    primitives, so the one row whose body arrived is the one that redraws.
 */

import { useCallback, useSyncExternalStore } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import { useEngineOrNull } from "./engine";

/** No engine in this tree (a bare harness mount): nothing to subscribe to, and nothing arrives. */
const NEVER = (): (() => void) => () => {};

function subscriptionOf(engine: OhmailEngine | null): (cb: () => void) => () => void {
  return engine === null ? NEVER : (cb: () => void) => engine.subscribe(cb);
}

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
  const subscribe = useCallback(subscriptionOf(engine), [engine]);
  useSyncExternalStore(
    subscribe,
    () => (engine === null || messageId === null
      ? undefined
      : engine.read().get("message_body", messageId)),
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
  const subscribe = useCallback(subscriptionOf(engine), [engine]);
  return useSyncExternalStore(
    subscribe,
    () => (engine === null ? 0 : engine.read().stampOf("message_body")),
    () => 0,
  );
}
