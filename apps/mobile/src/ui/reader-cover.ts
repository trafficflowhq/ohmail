import { useEffect } from "react";

/**
 * IS THE READER IN SIGHT? The thread-read rule reads a message only while its top is on screen in a
 * visible, focused window (owner ruling 2026-10-23). `AppState` says only half of that: it stays
 * `active` under a `Modal` — every `Sheet`, the composer — and under Android's notification shade,
 * where only the window's focus changes. So a reply that synced in while the person typed one lay
 * out below the opened message under the composer and was written read 0.7 s later, never seen.
 *
 * Every modal that stands over the reader covers it while shown (`useReaderCover`), the reader
 * reports its window's focus (`AppState` `blur`/`focus`, Android), and the reader looks only while
 * {@link readerSees}: nothing is read under a cover, and every dwell under way starts over, so a
 * message reads only once the reader is uncovered and its top is then on screen for the dwell.
 */

let covers = 0;
let focused = true;
const listeners = new Set<() => void>();
const changed = (): void => { for (const run of [...listeners]) run(); };

/** A modal stands over the reader; the returned release (idempotent) takes it away. */
export function coverReader(): () => void {
  covers += 1;
  changed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    covers -= 1;
    changed();
  };
}

/** The window's focus: `false` on Android's `blur` (the notification shade, a system dialog), `true` on `focus`. */
export function setReaderWindowFocused(on: boolean): void {
  if (focused === on) return;
  focused = on;
  changed();
}

/** Can the person be seeing the reader: the app in the foreground, its window focused, no modal over it? */
export function readerSees(appState: string): boolean {
  return appState === "active" && focused && covers === 0;
}

/** Called each time a cover comes or goes or the window's focus changes; returns the unsubscribe. */
export function onReaderCover(run: () => void): () => void {
  listeners.add(run);
  return () => { listeners.delete(run); };
}

/** A modal's hook: covers the reader while `shown`. */
export function useReaderCover(shown: boolean): void {
  useEffect(() => (shown ? coverReader() : undefined), [shown]);
}

export function resetReaderCoverForTests(): void {
  covers = 0;
  focused = true;
  listeners.clear();
}
