/**
 * A VALUE ONE PART OF THE TREE HANDS ANOTHER, without rendering the frame again: a shell's signals, the rail's model
 * and the connection's readings. A feed is told only when its value changed (by identity, or by the equality it is
 * made with).
 */
import type { Signal } from "./signals.js";

export interface Feed<T> extends Signal<T> {
  set(next: T): void;
}

export function createFeed<T>(first: T, same: (a: T, b: T) => boolean = Object.is): Feed<T> {
  let now = first;
  const told = new Set<() => void>();
  return {
    read: () => now,
    set(next) {
      if (same(now, next)) return;
      now = next;
      for (const tell of [...told]) tell();
    },
    subscribe(changed) {
      told.add(changed);
      return () => told.delete(changed);
    },
  };
}
