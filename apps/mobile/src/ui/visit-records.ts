/**
 * THE READER'S VISITS, held OUTSIDE the tree like `pane-memory`'s offsets. A fold or an unfold
 * remounts the reader for the same message (the pane hands the reading to the pushed route and back),
 * and a record made per mount forgot the visit: a message the person had marked unread was read
 * back by the new mount's first look. A visit's record lives while a reader shows its message; once
 * none does it ends after a grace that outlasts the handoff, and opening another message ends it at
 * once. A new visit to the same message after that is a fresh record, and so is its place: the
 * remembered scroll offset ends with the visit, so a reopen lands at its open anchor (the newest).
 */
import { createThreadRead, type ThreadRead } from "./reader-seen";
import { forgetPaneScroll } from "./pane-memory";

/** The reader's place lives as long as its visit (MessageReader's `scrollKey`). */
const endPlace = (id: string): void => forgetPaneScroll(`msg:${id}`);

/** How long a visit nobody shows waits for the remount a posture change makes. */
export const VISIT_HANDOFF_MS = 2000;

interface Visit {
  record: ThreadRead;
  shown: number;
  end: (() => void) | null;
}

const visits = new Map<string, Visit>();

type After = (ms: number, run: () => void) => () => void;
const later: After = (ms, run) => {
  const t = setTimeout(run, ms);
  return () => clearTimeout(t);
};

/** The visit's record for message `id`, made (and entered: a phone reader is an open) on first ask. */
export function visitRecordFor(id: string, now: number): ThreadRead {
  let v = visits.get(id);
  if (!v) {
    const record = createThreadRead();
    record.enter(now);
    v = { record, shown: 0, end: null };
    visits.set(id, v);
  }
  return v.record;
}

/** A reader shows message `id` (its mount): the visit stays, and every visit nobody shows ends. */
export function showVisit(id: string, now: number): void {
  for (const [k, v] of visits) {
    if (k !== id && v.shown === 0) {
      v.end?.();
      visits.delete(k);
      endPlace(k);
    }
  }
  visitRecordFor(id, now);
  const v = visits.get(id)!;
  v.end?.();
  v.end = null;
  v.shown += 1;
}

/** A reader stops showing message `id` (its unmount): with none left, the visit ends after the grace. */
export function hideVisit(id: string, after: After = later): void {
  const v = visits.get(id);
  if (!v) return;
  v.shown = Math.max(0, v.shown - 1);
  if (v.shown > 0) return;
  v.end?.();
  v.end = after(VISIT_HANDOFF_MS, () => {
    if (visits.get(id) === v && v.shown === 0) { visits.delete(id); endPlace(id); }
  });
}

/** A row press opens `id` afresh: a visit of it nobody shows (in its handoff grace) ends now, its place with it. */
export function endIdleVisit(id: string): void {
  const v = visits.get(id);
  if (!v || v.shown > 0) return;
  v.end?.();
  visits.delete(id);
  endPlace(id);
}

/** For the suite: every visit forgotten. */
export function resetVisitsForTests(): void {
  for (const v of visits.values()) v.end?.();
  visits.clear();
}
