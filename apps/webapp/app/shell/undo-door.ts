"use client";

/**
 * THE ONE UNDO DOOR. Every toast that offers Undo is raised through here, and the capsule's button
 * and the `z` key press ONE consume-once take: the key cannot take back another act than the
 * button on screen, nor the same act twice. The newest offer holds the door, as the newest Undo
 * capsule holds the toast's slot. It closes with the offer's own duration or its caller's signal
 * (a window that ended early); outside it `z` does nothing and claims nothing.
 */
import type { ToastFn, ToastOptions } from "@ohmail/ui";

/** A press whose Undo offer is still on its way (`expect`); `z` before the offer marks it asked. */
export interface UndoClaim { asked: boolean }

/** `undo: true` on an action is what arms `z`; any other action (a verdict's own press) does not.
 *  `claim` names the press the offer answers, so a `z` that came first takes it at once. */
export type UndoToastOptions = ToastOptions & { undo?: boolean; claim?: UndoClaim };
export type UndoToastFn = (message: string, options?: UndoToastOptions) => void;

export interface UndoDoor {
  /** Raise a sentence. With `undo` and `onAction` it is the live offer until it closes. */
  toast: UndoToastFn;
  /** The `z` key: take the live offer back. False when none is open. */
  press: () => boolean;
  /** A press was sent whose offer comes with its answer: `z` from now on is meant for it. */
  expect: () => UndoClaim;
  /** That press answered with no offer (refused, or replaced by a newer one). */
  drop: (claim: UndoClaim) => void;
}

/** The key the shell binds to the door's press; the capsule names it on its button. */
const UNDO_KEY = "z";

/** `ToastHost`'s own default, for an offer that names no duration. */
const TOAST_DEFAULT_MS = 2600;

/** How long an unanswered press keeps `z` for itself. */
const PENDING_MS = 8000;

export function createUndoDoor(show: ToastFn, now: () => number = () => Date.now()): UndoDoor {
  let live: { take: () => boolean; until: number } | null = null;
  let owed: { claim: UndoClaim; since: number } | null = null;
  const settle = (claim: UndoClaim | undefined): void => { if (claim && owed?.claim === claim) owed = null; };
  const toast: UndoToastFn = (message, options) => {
    const { undo, claim, ...plain } = options ?? {};
    const onAction = plain.onAction;
    settle(claim);
    // An offer raised at its press (a held Delete, a Screener decision) is newer than any owed press.
    if (undo && onAction && claim === undefined && !plain.signal?.aborted) owed = null;
    // `z` came before the offer: the undo it asked for happens now, and the offer is never shown.
    if (undo && onAction && claim?.asked && !plain.signal?.aborted) {
      onAction();
      return;
    }
    if (!undo || !onAction || plain.signal?.aborted) {
      show(message, options === undefined ? undefined : plain);
      return;
    }
    const ends = new AbortController();
    let taken = false;
    const close = () => { if (live?.take === take) live = null; };
    const take = (): boolean => {
      if (taken) return false;
      taken = true;
      close();
      // The capsule leaves with the offer, whichever of the two took it.
      ends.abort();
      onAction();
      return true;
    };
    plain.signal?.addEventListener("abort", () => { close(); ends.abort(); }, { once: true });
    live = { take, until: now() + (plain.duration ?? TOAST_DEFAULT_MS) };
    show(message, { ...plain, actionKey: UNDO_KEY, onAction: () => { take(); }, signal: ends.signal });
  };
  return {
    toast,
    expect: () => {
      const claim = { asked: false };
      owed = { claim, since: now() };
      return claim;
    },
    drop: settle,
    press: () => {
      // The newest press holds the door, its offer raised or not; one that never answers lets go.
      if (owed !== null && now() - owed.since <= PENDING_MS) {
        if (owed.claim.asked) return false;
        owed.claim.asked = true;
        return true;
      }
      owed = null;
      const offer = live;
      if (!offer || now() > offer.until) { live = null; return false; }
      return offer.take();
    },
  };
}
