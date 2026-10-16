/**
 * THE ONE WAY A TEST CROSSES THE FIRST-PAINT SEAM. Three deferrals live behind it: the Screener
 * queue's first derivation (`shell/first-paint.ts` — a macrotask under jsdom, which serves no
 * `requestIdleCallback`), the lazy Settings/Compose chunks, and the editor's own (`React.lazy`,
 * module promises). One timer tick settles the first; the lazy boundaries are waited out by what
 * they show, never by a count of rounds, and fake-timer suites run the due timers rather than
 * waiting for a real tick.
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
type Fiber = { tag: number; memoizedState: unknown; child: Fiber | null; sibling: Fiber | null };

function boundariesOnFallback(): number {
  let pending = 0;
  for (const el of [document.body, ...document.body.querySelectorAll("*")]) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactContainer$"));
    if (!key) continue;
    const made = (el as unknown as Record<string, { stateNode?: { current?: Fiber } } | undefined>)[key];
    const stack: Fiber[] = made?.stateNode?.current ? [made.stateNode.current] : [];
    while (stack.length > 0) {
      const f = stack.pop()!;
      if (f.tag === SUSPENSE && f.memoizedState !== null) pending += 1;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
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
 * THE EDITOR'S OWN SEAM, for a test that opens one. `RichEditorLazy` defers `RichEditor.tsx`, so
 * the surface renders its frame until that module is evaluated and its boundary has swapped.
 */
export async function settleEditor(): Promise<void> {
  await import("../app/shell/RichEditor.js");
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  await untilNoFallback();
}

export async function settleFirstPaint(): Promise<void> {
  // The lazy panes' modules, evaluated here so the boundaries' own imports find them loaded.
  await Promise.all([
    import("../app/views/SettingsView.js"),
    import("../app/views/ComposeView.js"),
    // The editor is the third: `RichEditorLazy` defers it behind its own boundary, so a reply,
    // a signature row and the Reply Run all render their frame until this module is evaluated.
    import("../app/shell/RichEditor.js"),
  ]);
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  // The settle's own re-render, and a pending lazy boundary's retry — microtasks only.
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
  await untilNoFallback();
}
