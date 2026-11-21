"use client";

/**
 * One page of Trash, held by the view — the off-mirror read. Not `older-mail.ts`: almost all of that hook's
 * complexity is the boundary between what it fetched and what the mirror holds, because a fetched row and a live
 * mirror row can be the same message. Here they cannot: a delete TOMBSTONES the row in every client's mirror
 * (`apply.ts` rule 4), so the mirror holds nothing for any message in this list — no overlap to arbitrate, no latch;
 * what is left is a cursor, a loading flag, an error and a list.
 */

/**
 * The rows are not put in the mirror (`OhmailEngine.listTrash`'s header: writing them in is the "a later create
 * resurrects" path, putting deleted mail back into somebody's Ohbox). The held restore is a local hide: the row must
 * leave at the press while the request waits out the Undo window, so {@link TrashPage.hidden} is the set the shell's
 * held-verb window publishes and this hook subtracts — `hideMessages`' job done by hand, no reader to wrap.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { OhmailEngine, TrashRowWire } from "@ohmail/client-engine";

const NO_IDS: readonly string[] = [];

/** How many rows one page asks for. The server clamps; this is the ask. */
export const TRASH_PAGE_LIMIT = 50;

export interface TrashPage {
  /**
   * Can this client see deleted mail at all? `false` for the demo and for any build whose
   * transport has no Trash route — a state the view must STATE ("Trash is not available here")
   * rather than render as an empty list, which would read as "you have deleted nothing".
   */
  available: boolean;
  /** The rows fetched so far, newest deletion first, minus anything a held restore is hiding. */
  items: TrashRowWire[];
  loading: boolean;
  /**
   * NON-NULL WHEN THE LAST ATTEMPT FAILED, and the EMPTY STRING is a real value —
   * `older-mail.ts`'s distinction, kept deliberately: `null` renders no failure line, `""`
   * renders the surface's own sentence with nothing appended, because most of what a server puts
   * in an error message is written for whoever reads a log rather than for the person holding
   * the mailbox.
   */
  error: string | null;
  /** The server has said there is no more. Distinct from an empty list nobody has asked about. */
  exhausted: boolean;
  loadMore: () => void;
}

/**
 * ERROR CODES WHOSE MESSAGE IS WRITTEN FOR THE PERSON — `older-mail.ts`'s allowlist, and it is
 * the same list for the same reason: the spend gate's 402 says what ran out and what to do about
 * it, and replacing it with "could not be loaded" would take away the only thing that would let
 * the reader fix it. Everything else is developer text and is withheld.
 */
const SPEAKS_TO_THE_READER: ReadonlySet<string> = new Set(["payment_required"]);

/** Absence is known only after the last successful page. Stop as soon as all candidates are found. */
async function absentFromTrash(
  engine: OhmailEngine,
  candidates: ReadonlySet<string>,
  current: () => boolean,
): Promise<ReadonlySet<string> | null> {
  const missing = new Set(candidates);
  const seen = new Set<string>();
  let cursor: string | null = null;
  while (current()) {
    const page = await engine.listTrash({ limit: TRASH_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    if (!current() || page.state !== "ready") return null;
    for (const row of page.items) missing.delete(row.id);
    cursor = page.nextCursor;
    if (missing.size === 0 || cursor === null) return missing;
    if (seen.has(cursor)) return null;
    seen.add(cursor);
  }
  return null;
}

export function useTrashPage(
  engine: OhmailEngine,
  /**
   * IS THIS VIEW THE ROUTE. The first page is fetched when it becomes true and the state is
   * DROPPED when it goes false — the rows are off-mirror and stale the moment somebody leaves,
   * and holding them would render yesterday's Trash on the next visit while a fresh page loads
   * behind it.
   */
  active: boolean,
  /** Ids a held restore is hiding — the shell's window publishes this set. See the header. */
  hidden: ReadonlySet<string>,
  /** Deletes the server has confirmed so far (`useDeleteUndo`'s `landed`); a rise re-reads page one. */
  landed = 0,
  /** Restores the server has taken (the restore window's `landedIds`, append-only): each leaves the list. */
  restored: readonly string[] = NO_IDS,
): TrashPage & { readonly removed: ReadonlySet<string> } {
  const [items, setItems] = useState<TrashRowWire[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const listed = useRef({ items, hidden });
  listed.current = { items, hidden };
  /* A LANDED RESTORE LEAVES THE LIST. `hidden` covers a restore only until the server answers; the row itself stayed
     in `items` and was listed again after. Adjusted during render, so no frame shows it back. */
  const [restoredSeen, setRestoredSeen] = useState(restored.length);
  if (restoredSeen !== restored.length) {
    const gone = new Set(restored.slice(restoredSeen));
    setRestoredSeen(restored.length);
    setItems((prev) => (prev.some((r) => gone.has(r.id)) ? prev.filter((r) => !gone.has(r.id)) : prev));
  }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  /* THE CURSOR IN A REF, not in state: it is read inside `loadMore` and never rendered, and as
     state it would rebuild the callback on every page — which the mount effect below depends on,
     so a new identity per page is a re-fetch of page one. */
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);

  const available = engine.trashAvailable();
  useLayoutEffect(() => {
    if (!active || !available) return;
    let activeVisit = true;
    const latestConfirmation = new Map<string, symbol>();
    const stop = engine.onMessagesRemoved((_ids, applied) => {
      const { items, hidden } = listed.current;
      const candidates = new Set(items.filter((row) => applied.has(row.id) && !hidden.has(row.id)).map((row) => row.id));
      if (candidates.size === 0) return;
      const request = Symbol();
      for (const id of candidates) latestConfirmation.set(id, request);
      // This engine's account-bound read decides membership. A filing and a later removal both tombstone the mirror.
      void absentFromTrash(engine, candidates, () => activeVisit).then((missing) => {
        if (!activeVisit) return;
        const current = new Set<string>();
        for (const id of candidates) {
          if (latestConfirmation.get(id) !== request) continue;
          latestConfirmation.delete(id);
          current.add(id);
        }
        if (missing === null || current.size === 0) return;
        const { items, hidden } = listed.current;
        const eligible = items.filter((row) => current.has(row.id) && !hidden.has(row.id)).map((row) => row.id);
        setRemoved((was) => {
          if (!eligible.some((id) => was.has(id) !== missing.has(id))) return was;
          const next = new Set(was);
          for (const id of eligible) {
            if (missing.has(id)) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      });
    });
    return () => {
      activeVisit = false;
      stop();
    };
  }, [active, available, engine]);

  const loadMore = useCallback(() => {
    if (!available || inFlight.current || exhausted) return;
    inFlight.current = true;
    setLoading(true);
    void engine
      .listTrash({ limit: TRASH_PAGE_LIMIT, ...(cursor.current ? { cursor: cursor.current } : {}) })
      .then((outcome) => {
        if (outcome.state === "unavailable") {
          /* The transport went away between the gate and the ask. Not a failure sentence: there
             is nothing to retry and nothing went wrong — `available` already reads false on the
             next render and the view says so. */
          setExhausted(true);
          return;
        }
        if (outcome.state === "failed") {
          setError(
            outcome.code !== null && SPEAKS_TO_THE_READER.has(outcome.code) ? outcome.error : "",
          );
          return;
        }
        setError(null);
        /* APPEND, DE-DUPLICATED BY ID. The keyset walks `folder_state.updated_at desc`, and a
           delete landing between two pages shifts that ordering — so a row can legitimately
           arrive twice, and a bare append would render it twice. First copy wins: it is the one
           already on screen, and re-rendering the row under the reader would move it. */
        setItems((prev) => {
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...outcome.items.filter((r) => !seen.has(r.id))];
        });
        cursor.current = outcome.nextCursor;
        if (outcome.nextCursor === null) setExhausted(true);
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
    // `engine` is stable for the life of a mount; `exhausted` and `available` are the gates.
  }, [engine, available, exhausted]);

  /* THE FIRST PAGE ON ARRIVAL, AND A FULL RESET ON LEAVING. Unlike the reach-past — which never
     fires speculatively, because there a person asking IS the ask — arriving in Trash is the
     ask: the whole view is the list, and an empty screen with a button on it would be a screen
     asking somebody to press a thing to see the thing they navigated to. */
  useEffect(() => {
    if (!active) {
      cursor.current = null;
      inFlight.current = false;
      setItems([]);
      setRemoved(new Set());
      setError(null);
      setExhausted(false);
      setLoading(false);
      return;
    }
    loadMore();
    // Only the route's own edge: `loadMore`'s identity moves with `exhausted`, and re-running on
    // that would ask for page one again the moment the walk finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /* A DELETE THAT LANDS WHILE TRASH IS OPEN. Page one was read on arrival, often while the delete
     was still held for its Undo, so it is read again and its new rows go on top; the cursor and
     the rows below are kept. Away from Trash nothing is read: the next arrival reads page one. */
  const visit = useRef(0);
  const seenLanded = useRef(landed);
  useEffect(() => { visit.current += 1; }, [active]);
  useEffect(() => {
    if (seenLanded.current === landed) return;
    seenLanded.current = landed;
    if (!active || !available) return;
    const at = visit.current;
    void engine.listTrash({ limit: TRASH_PAGE_LIMIT }).then((outcome) => {
      if (visit.current !== at || outcome.state !== "ready") return;
      setItems((prev) => {
        const have = new Set(prev.map((r) => r.id));
        const fresh = outcome.items.filter((r) => !have.has(r.id));
        return fresh.length === 0 ? prev : [...fresh, ...prev];
      });
    });
  }, [landed, active, available, engine]);

  return {
    available,
    items: removed.size === 0 && hidden.size === 0
      ? items : items.filter((row) => !hidden.has(row.id) && !removed.has(row.id)),
    removed,
    loading,
    error,
    exhausted,
    loadMore,
  };
}
