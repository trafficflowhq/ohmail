"use client";

/**
 * THE ONE UNDO DOOR. Every toast that offers Undo is raised through here, and the capsule's button
 * and the `z` key press ONE consume-once take: the key cannot take back another act than the
 * button on screen, nor the same act twice. The newest offer holds the door, as the newest Undo
 * capsule holds the toast's slot. It closes with the offer's own duration or its caller's signal
 * (a window that ended early); outside it `z` does nothing and claims nothing.
 */
import type { ToastFn, ToastOptions } from "@ohmail/ui";

/** `undo: true` on an action is what arms `z`; any other action (a verdict's own press) does not. */
export type UndoToastOptions = ToastOptions & { undo?: boolean };
export type UndoToastFn = (message: string, options?: UndoToastOptions) => void;

export interface UndoDoor {
  /** Raise a sentence. With `undo` and `onAction` it is the live offer until it closes. */
  toast: UndoToastFn;
  /** The `z` key: take the live offer back. False when none is open. */
  press: () => boolean;
}

/** `ToastHost`'s own default, for an offer that names no duration. */
const TOAST_DEFAULT_MS = 2600;

export function createUndoDoor(show: ToastFn, now: () => number = () => Date.now()): UndoDoor {
  let live: { take: () => boolean; until: number } | null = null;
  const toast: UndoToastFn = (message, options) => {
    const { undo, ...plain } = options ?? {};
    const onAction = plain.onAction;
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
    show(message, { ...plain, onAction: () => { take(); }, signal: ends.signal });
  };
  return {
    toast,
    press: () => {
      const offer = live;
      if (!offer || now() > offer.until) { live = null; return false; }
      return offer.take();
    },
  };
}
