/**
 * WHAT A PAGE HOLDS OF WHAT NATIVE LAST TOLD IT, as the host contract's signals: a cell (the value, read and
 * subscribed to, set by the bridge's events), and back's handlers, newest first. Both pages stand on these, the
 * scoped page (`signals.ts`) and the door's (`door/handle.ts`). This file imports nothing, so the door's bundle takes
 * it without the scoped page's engine, which `signals.ts` reaches.
 */
import type { BackSignal, Signal } from "@ohmail/app/host";

export function cell<T>(initial: T): Signal<T> & { set(next: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe(changed) {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    set(next) {
      value = next;
      for (const l of listeners) l();
    },
  };
}

/** Back's handlers: `took()` asks them newest first, and the first to answer true took it. */
export function backHandlers(): BackSignal & { took(): boolean } {
  const backs: (() => boolean)[] = [];
  return {
    subscribe(handle) {
      backs.push(handle);
      return () => {
        const at = backs.lastIndexOf(handle);
        if (at >= 0) backs.splice(at, 1);
      };
    },
    took: () => [...backs].reverse().some((handle) => handle()),
  };
}
