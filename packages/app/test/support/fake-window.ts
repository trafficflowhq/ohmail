/**
 * THE FAKE WINDOW, THE FAKE ADDRESS AND A SIGNAL A TEST CAN MOVE. The frame reads the window, the look and
 * the address only through the host's device keys; these stand in for a browser's, and nothing changes
 * unless the test says so.
 */
import type { Appearance, FrameAddress, Pointer, WindowFacts } from "../../src/frame/contract.js";
import { leaveHold } from "../../src/host/leave-hold.js";
import type { Signal } from "../../src/host/index.js";

export interface MovableSignal<T> extends Signal<T> {
  set(next: T): void;
}

export function movable<T>(first: T): MovableSignal<T> {
  let now = first;
  const told = new Set<() => void>();
  return {
    read: () => now,
    subscribe(changed) {
      told.add(changed);
      return () => told.delete(changed);
    },
    set(next) {
      now = next;
      for (const tell of [...told]) tell();
    },
  };
}

/** The four rooms the plan is read at, by name. */
export const ROOMS = {
  phone: { width: 390, height: 844, pointer: "coarse" },
  fold: { width: 719, height: 781, pointer: "coarse" },
  land: { width: 841, height: 673, pointer: "coarse" },
  desktop: { width: 1440, height: 900, pointer: "fine" },
} as const satisfies Record<string, { width: number; height: number; pointer: Pointer }>;

export interface FakeWindow extends MovableSignal<WindowFacts> {
  /** The window is dragged to another size, or another room is taken. */
  resize(width: number, height?: number, pointer?: Pointer): void;
}

export function fakeWindow(room: keyof typeof ROOMS | WindowFacts): FakeWindow {
  const first: WindowFacts =
    typeof room === "string" ? { ...ROOMS[room], posture: "flat", reducedMotion: false } : room;
  const signal = movable(first);
  return {
    ...signal,
    resize(width, height, pointer) {
      const was = signal.read();
      signal.set({ ...was, width, height: height ?? was.height, pointer: pointer ?? was.pointer });
    },
  };
}

export interface FakeAddress extends FrameAddress {
  /** Every write, in order, with how it was written. */
  readonly writes: { next: string; how: "push" | "replace" }[];
  /** The person types an address or presses Back. */
  visit(next: string): void;
}

export function fakeAddress(first = "#/ohbox"): FakeAddress {
  const hold = leaveHold();
  const fragment = movable(first);
  const writes: { next: string; how: "push" | "replace" }[] = [];
  return {
    holdLeave: hold.holdLeave,
    heldBefore: hold.heldBefore,
    read: fragment.read,
    subscribe: fragment.subscribe,
    writes,
    write: function write(next, how) {
      if (hold.heldBefore(next, () => write(next, how))) return;
      writes.push({ next, how });
      fragment.set(next);
    },
    visit(next) {
      if (!hold.heldBefore(next, () => fragment.set(next))) fragment.set(next);
    },
  };
}

export function fakeAppearance(
  first: Appearance = { face: "paper", scheme: "light" },
): MovableSignal<Appearance> {
  return movable(first);
}
