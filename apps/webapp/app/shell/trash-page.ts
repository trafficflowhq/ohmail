"use client";

/**
 * ONE PAGE OF TRASH, HELD BY THE VIEW — the off-mirror read.
 *
 * ══ WHY THIS IS NOT `older-mail.ts` ═════════════════════════════════════════════════════════
 *
 * `useOlderMail` pages mail from BEYOND the mirror's window, and almost all of its complexity is
 * the boundary between what it fetched and what the mirror holds: a four-verdict `suppress`
 * predicate asked per render, a ban latch, a scope epoch. Every bit of that exists because a
 * fetched row and a live mirror row can be the same message.
 *
 * Here they cannot. A delete TOMBSTONES the row in every client's mirror (`apply.ts` rule 4,
 * `entity: null`), so the mirror holds NOTHING for any message in this list, on any door. There
 * is no overlap to arbitrate, no row to prefer, no latch to keep. What is left is a cursor, a
 * loading flag, an error and a list — which is this file.
 *
 * ══ AND WHY THE ROWS ARE NOT PUT IN THE MIRROR ══════════════════════════════════════════════
 *
 * `OhmailEngine.listTrash`'s own header carries it: writing them in would be exactly the "a
 * LATER create resurrects" path, putting deleted mail back into somebody's Ohbox while the mail
 * server still has it in Trash. They live here, for as long as the view is mounted.
 *
 * ══ THE HELD RESTORE IS A LOCAL HIDE ════════════════════════════════════════════════════════
 *
 * The row must leave the list at the press, and the request does not go out until the Undo
 * window closes — so the disappearance cannot be the mutation's. {@link TrashPage.hidden} is the
 * set the shell's held-verb window publishes and this hook subtracts, which is `hideMessages`'
 * job on the mirror side done by hand here because there is no reader to wrap.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OhmailEngine, TrashRowWire } from "@ohmail/client-engine";

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
): TrashPage {
  const [items, setItems] = useState<TrashRowWire[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  /* THE CURSOR IN A REF, not in state: it is read inside `loadMore` and never rendered, and as
     state it would rebuild the callback on every page — which the mount effect below depends on,
     so a new identity per page is a re-fetch of page one. */
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);

  const available = engine.trashAvailable();

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

  return {
    available,
    items: hidden.size === 0 ? items : items.filter((r) => !hidden.has(r.id)),
    loading,
    error,
    exhausted,
    loadMore,
  };
}
