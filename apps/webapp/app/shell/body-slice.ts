"use client";

/**
 * THE BODY SLICE — the one part of the mirror read BY ID at draw time, and the only part with a
 * subscription of its own. Everything else the window shows is a whole-mirror derivation; nothing
 * lists bodies, so a body concerns only the surface drawing that message.
 *
 * The shell's derivations key on {@link useDerivedVersion}, which bodies do not move — so a
 * surface that draws one must ask here, or it goes on showing the loading marker's snippet
 * (`derived-stamp-census.test.ts` refuses a `bodyOf` draw with no subscription). {@link useDrawnBody}
 * draws ONE message with its subscription; {@link useBodyStamp} draws many in a loop.
 */

import type { MessageBody } from "@ohmail/wire";
import { useCallback, useSyncExternalStore } from "react";
import { useBodyArrival } from "@ohmail/app-logic/reading/body-arrival";
import { useEngineOrNull } from "./engine";
import { useMessageChrome, type BodyTarget } from "./message-chrome";

/* The body's arrival moved to `@ohmail/app-logic/reading` (the new reader takes it too); its two names stay here. */
export { useBodyArrival, useBodyStamp } from "@ohmail/app-logic/reading/body-arrival";

/** Unsubscribing from nothing — a bare harness mount has no engine, and nothing will arrive. */
const NOTHING_TO_STOP = (): void => {};

/**
 * THE ONE DOOR A DRAWN BODY IS READ THROUGH — the reader's (`MessagePane`, `MessageCard`) and the
 * Screener's held preview's. The chrome's `bodyOf` is the shell's single answer (mirror row or
 * reach-past door), and the arrival subscription is taken with it, so no surface can draw a body
 * that stopped moving. The held preview used to draw the queue's DERIVED copy, which the derived
 * stamp never re-derives for a body: read and never shown on a quiet mailbox (2026-09-25).
 */
export function useDrawnBody(target: BodyTarget): MessageBody;
export function useDrawnBody(target: BodyTarget | null): MessageBody | null;
export function useDrawnBody(target: BodyTarget | null): MessageBody | null {
  const chrome = useMessageChrome();
  useBodyArrival(target?.id ?? null);
  return target === null ? null : chrome.bodyOf(target);
}

/**
 * The drawn STATES of several bodies through the same door, as one string — for a surface keyed on
 * them rather than drawing them (the Screener's anchor re-runs when a held entry grows). A `null`
 * target is a row that carries its own body and contributes an empty slot.
 */
export function useDrawnStates(targets: ReadonlyArray<BodyTarget | null>): string {
  const engine = useEngineOrNull();
  const chrome = useMessageChrome();
  const subscribe = useCallback(
    (cb: () => void) => (engine === null ? NOTHING_TO_STOP : engine.subscribe(cb)),
    [engine],
  );
  const states = (): string => targets.map((t) => (t === null ? "" : chrome.bodyOf(t).state)).join(",");
  return useSyncExternalStore(subscribe, states, () => "");
}
