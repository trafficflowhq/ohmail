/**
 * THE ONE WAY A TEST CROSSES THE FIRST-PAINT SEAM. What the new shell (the frame over the mail
 * ground) defers at its first paint is the Screener queue's first derivation
 * (`@ohmail/app-logic/session/first-paint.ts` — a macrotask under jsdom, which serves no
 * `requestIdleCallback`); it draws no lazy boundary of its own (Write's editor is a static import of
 * `@ohmail/app/write`). One timer tick settles the derivation; any lazy boundary still on screen is
 * waited out by what it shows, never by a count of rounds, and fake-timer suites run the due timers
 * rather than waiting for a real tick. NOTHING OF TODAY'S SHELL IS WARMED HERE: the door imports no
 * view and no part that leaves with the switch, so a test through it runs only what stays.
 */
import * as React from "react";
import { vi } from "vitest";

const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/* A real macrotask whatever the file does to the clock: read when this module loads, which is
   before any file's beforeEach fakes the timers (imports are hoisted above the file's body). */
const realSetTimeout = globalThis.setTimeout.bind(globalThis);

/* A Suspense boundary is React's tag 13; its memoizedState is non-null while it shows the
   fallback. Read from each root's live tree: the container holds the root fiber it was made with,
   whose stateNode (the FiberRoot) names the current one. */
const SUSPENSE = 13;
const HOST_ROOT = 3;
type Fiber = { tag: number; memoizedState: unknown; child: Fiber | null; sibling: Fiber | null };

/* THESE ARE REACT'S INTERNALS, so the walk refuses to guess when they stop looking like this. It
   was measured on React 19 (the container key, HostRoot = 3, SuspenseComponent = 13); another major
   must be measured again before it is trusted. And a page with content but no root this walk can
   find, or a root whose live fiber is not a HostRoot, is a walk that would see no boundary and wait
   for nothing, which turns the cold-start race it exists for back into a quiet flake. All three
   fail here, by name. */
const MEASURED_ON_REACT = "19.";

function boundariesOnFallback(): number {
  if (!React.version.startsWith(MEASURED_ON_REACT)) {
    throw new Error(`the first-paint settle reads React ${MEASURED_ON_REACT}x internals and this is React ${React.version}: measure the container key and the fiber tags again in _first-paint.ts`);
  }
  let pending = 0;
  let keys = 0;
  for (const el of [document.body, ...document.body.querySelectorAll("*")]) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactContainer$"));
    if (!key) continue;
    keys += 1;
    const made = (el as unknown as Record<string, { stateNode?: { current?: Fiber } } | null | undefined>)[key];
    // An unmounted root: React leaves the key on its container and sets it to null.
    if (made == null) continue;
    const live = made.stateNode?.current;
    if (!live || live.tag !== HOST_ROOT) {
      throw new Error(`the first-paint settle found a React container whose live root is not a HostRoot (tag ${String(live?.tag)}): React's root shape changed, see _first-paint.ts`);
    }
    const stack: Fiber[] = [live];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (f.tag === SUSPENSE && f.memoizedState !== null) pending += 1;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
  }
  // The key itself, live or cleared: a rename is what this catches, and an unmounted root still carries it.
  if (keys === 0 && document.body.childElementCount > 0) {
    throw new Error("the first-paint settle found a rendered page but no React container on it: the __reactContainer$ key it reads is gone, so it can no longer see a Suspense boundary; see _first-paint.ts");
  }
  return pending;
}

/**
 * EVERY LAZY BOUNDARY ON SCREEN HAS ITS VIEW. A module that is already evaluated does not make
 * `React.lazy`'s factory a microtask: the factory's own `import("../views/ComposeView")` names a
 * specifier relative to the shell, and vitest's runner resolves every such specifier by a round
 * trip to its main process — a real message, landing after some number of macrotasks that depends
 * on how busy that process is. One timer tick won that race on a warm run and lost it on a cold
 * one (a file alone, or first in its shard), and the view's first query found an empty stage.
 * So: real macrotask rounds until no boundary shows its fallback, bounded, and named when not.
 */
async function untilNoFallback(): Promise<void> {
  const bound = 2000;
  for (let waited = 0; boundariesOnFallback() > 0; waited += 5) {
    if (waited >= bound) {
      throw new Error(`a Suspense boundary still showed its fallback after ${bound} ms of real time`);
    }
    await act(async () => { await new Promise<void>((resolve) => realSetTimeout(resolve, 5)); });
  }
}

/**
 * THE EDITOR'S OWN SEAM, for a test that opens one: the press's re-render, then any boundary still
 * on its fallback waited out by what it shows (Write's editor is not deferred; a lazy editor still
 * drawn by a part that has not left yet swaps when its module lands).
 */
export async function settleEditor(): Promise<void> {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  await untilNoFallback();
}

export async function settleFirstPaint(): Promise<void> {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  // The settle's own re-render, and a pending lazy boundary's retry — microtasks only.
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  await untilNoFallback();
}
