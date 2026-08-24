"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineMessage, OhmailEngine, OhmailView } from "@ohmail/client-engine";

/**
 * THE BOTTOM OF A PILE, WHEN THE DEVICE HOLDS ONLY PART OF THE MAILBOX.
 *
 * The browser's mirror is a window: the newest slice of the mail, kept on disk, in front of a
 * server that still holds all of it. That makes the end of a list an ambiguous place. It can mean
 * "this is your mail" or it can mean "this is what this device kept", and those are different
 * sentences — one of them has more mail behind it and the other does not.
 *
 * This hook is what lets a list tell them apart and act on the difference. It asks the engine
 * whether there is anything further back at all, fetches one page at a time when somebody asks
 * for it, and reports what it has in a shape a surface can render honestly.
 *
 * ── ONE PAGE PER ASK, NEVER SPECULATIVE ─────────────────────────────────────────────────────
 *
 * Nothing here fires on mount, on scroll position, or on a re-render. The fetch happens when
 * {@link OlderMail.loadMore} is called, which is a person reaching the end of a list and asking
 * to see further. A pile-wide prefetch would be the whole mailbox coming back down the wire to
 * fill a mirror that deliberately does not want it.
 *
 * ── THE ROWS ARE NOT MIRROR ROWS, AND THAT IS THE POINT ─────────────────────────────────────
 *
 * `engine.listOlder` returns items and writes nothing: they have no sync sequence, so the mirror
 * has no way to reconcile them and the next prune pass would evict them anyway. They live here,
 * in this hook's state, for as long as the view is open.
 *
 * The MERGE prefers the mirror's own row wherever it has one. The mirror row carries the
 * optimistic overlay and this device's triage state; a wire item is a snapshot from before
 * whatever the user just did. Preferring the wire would make a message somebody has just filed
 * reappear in the pile they filed it out of.
 *
 * ── RESET ON VIEW CHANGE ────────────────────────────────────────────────────────────────────
 *
 * Everything is keyed to one view. Leaving and returning starts again from the top of the older
 * mail rather than resuming a cursor from a list that is no longer on screen — a paging position
 * is only meaningful while the list it pages is being read.
 */

/** What the surface renders below its own rows. */
export interface OlderMail {
  /**
   * Is there anywhere further back to look?
   *
   * `false` for a client whose mirror IS the mailbox — the demo, and the standalone desktop
   * client. A list must render nothing at all in that case: an affordance to load older mail,
   * over a client that has every message already, is an offer that cannot be kept.
   */
  available: boolean;
  /** Older messages fetched so far, mirror-preferred by id, in the order the server sent them. */
  items: EngineMessage[];
  /** A page is in flight. */
  loading: boolean;
  /**
   * NON-NULL WHEN THE LAST ATTEMPT FAILED. The string is a sentence to append to the surface's
   * own failure copy — and it is the EMPTY STRING for most failures, on purpose.
   *
   * `null` and `""` are different states and the difference is load-bearing: `null` is "nothing
   * has gone wrong", which renders no failure line at all, and `""` is "this failed and the
   * server had nothing to say that a person should read", which renders the surface's own
   * sentence and its retry control with nothing appended. See {@link readerFacing}.
   */
  error: string | null;
  /**
   * The server has said there is no more. Distinct from `items.length === 0`, which is what a
   * list looks like before anyone has asked, and distinct from a failure — a surface that
   * conflated the three would claim the mailbox ends where the network did.
   */
  exhausted: boolean;
  /** Ask for the next page. A no-op while one is in flight, or once the server has said no more. */
  loadMore: () => void;
}

interface Page {
  items: EngineMessage[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
  exhausted: boolean;
}

const EMPTY: Page = { items: [], cursor: null, loading: false, error: null, exhausted: false };

/**
 * ERROR CODES WHOSE MESSAGE IS WRITTEN FOR THE PERSON, NOT FOR A LOG.
 *
 * An ALLOWLIST, and it has to be one. A server's error message is developer text by default: it
 * names internal vocabulary, it is not translated, and it is written on the assumption that
 * whoever reads it can change the request. Passing it through to a mail list means the first
 * refusal nobody anticipated is published verbatim into somebody's mailbox — which is exactly how
 * a validation message listing the server's own internal view names came to be rendered under a
 * pile of mail.
 *
 * The spend gate is the exception the list exists for. A 402 here says what ran out and what to
 * do about it; replacing it with "could not be loaded" would take away the only thing that would
 * let the reader fix it. So the rule is: say nothing extra unless the server's sentence was
 * addressed to the reader.
 */
const SPEAKS_TO_THE_READER: ReadonlySet<string> = new Set(["payment_required"]);

/**
 * The part of a refusal a surface may show, which is usually none of it.
 *
 * Returns `""` rather than `null` deliberately — see {@link OlderMail.error}. The failure still
 * has to be visible and still has to offer a retry; it is only the server's WORDS that are
 * withheld.
 */
function readerFacing(outcome: { error: string; code: string | null }): string {
  return outcome.code !== null && SPEAKS_TO_THE_READER.has(outcome.code) ? outcome.error : "";
}

export function useOlderMail(
  engine: OhmailEngine,
  view: OhmailView | "folder",
  version: number,
  /** With `view: "folder"`: the folder ENTITY id. Undefined reads as "no list" (unavailable). */
  folderId?: string,
  /**
   * The caller's mirror boundary — the OLDEST row the mirror renders for this scope, as a
   * (date, id) keyset position. Page one starts strictly below it, so the reach-past never
   * re-serves the rows already on screen above it. Read once per scope, at the first ask.
   */
  startBelow?: { date: string | null; id: string },
  /**
   * "MUST THIS FETCHED ROW STAY OUT OF THE TAIL RIGHT NOW?" — asked per render, of the LIVE
   * mirror, never remembered. Without a boundary the first pages routinely overlap the
   * mirror's window, and each wrong shape of hiding tells its own lie:
   *
   *  · a filter against the surface's own list resurfaces a row MOVED out of the scope (it
   *    leaves the list, so the filter releases it) and counts rows it hides;
   *  · a remembered accept-time discard makes mail VANISH when the windowed mirror later
   *    hard-prunes the live row — the fetched copy was thrown away and the id stayed banned,
   *    so an open folder silently omitted mail the server still holds.
   *
   * So the fetched copies are all KEPT, and this predicate answers per render with THREE
   * verdicts, because eviction and an authoritative removal must not read alike:
   *
   *  · `"hide"` — the surface above renders the row right now; the tail stays quiet;
   *  · `"ban"`  — the mirror shows the row has LEFT this scope (moved elsewhere): the fetched
   *    pre-move copy is stale by the mirror's word, and the id is latched out, so a LATER
   *    hard-prune of the moved row cannot revive it here;
   *  · `"show"` — the mirror does not hold the row: evicted by the window's policy, or
   *    genuinely older mail. The fetched copy renders (unless latched).
   *
   * The latch fires on OBSERVATION — a render that sees the moved row — and it CLEARS on the
   * opposite observation: a render whose verdict is `"hide"` (the mirror holds the row in this
   * scope again) deletes the ban, because the mirror the caller reads is overlay-aware and a
   * pending optimistic move also answers `"ban"` — a hard-rejected move rolls the row back
   * into the scope, and a row can be genuinely moved back, and neither may leave a stale latch
   * that outlives a later eviction. The newest observed word wins in both directions. The one
   * residual it cannot close is a change applied and hard-pruned inside a single render tick
   * of an open scope, which no reader of the live mirror can distinguish from eviction; named
   * here rather than papered over.
   */
  suppress?: (id: string) => "show" | "hide" | "ban",
): OlderMail {
  const available = engine.listOlderAvailable();
  const [page, setPage] = useState<Page>(EMPTY);

  // The view (or the engine) changed: a cursor into one list means nothing in another.
  useEffect(() => {
    setPage(EMPTY);
  }, [engine, view, folderId]);

  /**
   * THE PAGING POSITION, AS REFS RATHER THAN AS STATE READ INSIDE `loadMore`.
   *
   * Three reasons, and the third is the one that bites:
   *
   *  · `loadMore` is stable across renders — a list hangs it on a button and, if it wants, on an
   *    intersection observer — so a cursor CLOSED OVER would be the one from the render that
   *    created the callback, and every page would ask for page one;
   *  · two calls in the same tick both read a `loading` React has not re-rendered yet. The engine
   *    coalesces identical view+cursor requests, so the cost was never a duplicate fetch; it is
   *    the same page APPENDED twice, which is the same mail on screen twice;
   *  · a `setState` updater must be pure. Firing the request from inside one would issue it twice
   *    under StrictMode's double-invoke, which is a real request against somebody's mailbox.
   */
  const cursor = useRef<string | null>(null);
  /** `suppress` behind a stable identity, so the memo's deps stay honest — consent-state's `link`. */
  const suppressRef = useRef<((id: string) => "show" | "hide" | "ban") | undefined>(suppress);
  suppressRef.current = suppress;
  /** Ids OBSERVED leaving the scope — the `"ban"` latch, per scope. See `suppress`. */
  const banned = useRef(new Set<string>());
  /** The scope this hook's page state belongs to — returned EMPTY synchronously on mismatch,
   *  because the reset below is an effect and runs one render late: without this, switching
   *  folders rendered the previous folder's fetched rows under the new folder's title. */
  const scope = `${view}|${folderId ?? ""}`;
  const pageScope = useRef(scope);
  const inFlight = useRef(false);
  const done = useRef(false);
  /**
   * WHICH LIST A RESPONSE BELONGS TO.
   *
   * The reset below cannot cancel a request that is already out. Without a token, a page asked
   * for in one view lands after the reset and is appended to a DIFFERENT view's list — mail from
   * one pile rendered at the bottom of another, which is the one mistake this whole surface
   * exists to avoid making. Bumped on every reset; a response carrying a stale token is dropped.
   */
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    cursor.current = null;
    inFlight.current = false;
    done.current = false;
    banned.current = new Set();
    pageScope.current = scope;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, view, folderId]);

  const loadMore = useCallback(() => {
    if (!available || inFlight.current || done.current) return;
    inFlight.current = true;
    const mine = generation.current;
    setPage((p) => ({ ...p, loading: true, error: null }));

    void engine
      .listOlder(view, {
        ...(cursor.current ? { cursor: cursor.current } : {}),
        ...(folderId ? { folderId } : {}),
        ...(!cursor.current && startBelow ? { startBelow } : {}),
      })
      .then((outcome) => {
        if (mine !== generation.current) return; // answered a list that is no longer on screen
        inFlight.current = false;
        if (outcome.state === "unavailable") {
          done.current = true;
          setPage((prev) => ({ ...prev, loading: false, exhausted: true }));
          return;
        }
        if (outcome.state === "failed") {
          // NOT exhausted. A refusal leaves the cursor where it was, so pressing again retries
          // the same page rather than skipping it — and the list keeps offering the control,
          // because "the network failed" is not "your mail ends here".
          //
          // The server's own words are filtered, not forwarded: the surface has a sentence for
          // this, and the raw message is developer text unless the code says otherwise.
          setPage((prev) => ({ ...prev, loading: false, error: readerFacing(outcome) }));
          return;
        }
        cursor.current = outcome.nextCursor;
        done.current = outcome.nextCursor === null;
        setPage((prev) => {
          // Appended BY ID, so a page the server repeats cannot render the same mail twice.
          // Overlap with the caller's surface is NOT discarded here: the fetched copy must
          // survive a later mirror prune of the live row (see the `suppress` parameter), so
          // hiding is the per-render predicate's job, never the accept's.
          const seen = new Set(prev.items.map((m) => m.id));
          const added = outcome.items.filter((m) => !seen.has(m.id));
          return {
            items: added.length === 0 ? prev.items : [...prev.items, ...added],
            cursor: outcome.nextCursor,
            loading: false,
            error: null,
            exhausted: outcome.nextCursor === null,
          };
        });
      });
  }, [engine, view, available, folderId, startBelow]);

  /**
   * MIRROR-PREFERRED BY ID, recomputed when the mirror changes.
   *
   * `version` is the engine's overlay-aware mirror version, so this re-runs when somebody files
   * one of these messages, marks it read, or a drain brings its row down — which is exactly when
   * a held wire item goes stale. Without it the older rows would freeze at the moment they were
   * fetched and quietly disagree with the list above them.
   */
  const items = useMemo(() => {
    if (page.items.length === 0) return page.items;
    const reader = engine.read();
    return page.items
      // The per-render verdicts — see `suppress`: hide what the surface shows, LATCH what the
      // mirror says has left the scope, show what the mirror no longer holds. A row observed
      // BACK in the scope clears its latch first — the newest word wins in both directions.
      .filter((item) => {
        const verdict = suppressRef.current?.(item.id) ?? "show";
        if (verdict === "hide") {
          banned.current.delete(item.id);
          return false;
        }
        if (verdict === "ban") {
          banned.current.add(item.id);
          return false;
        }
        return !banned.current.has(item.id);
      })
      .map((item) => reader.get<EngineMessage>("message", item.id) ?? item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, page.items, version]);

  // A scope the reset effect has not caught up with yet returns the RESTING page, never the
  // previous scope's rows — see `pageScope`.
  const current = pageScope.current === scope;
  return {
    available,
    items: current ? items : [],
    loading: current ? page.loading : false,
    error: current ? page.error : null,
    exhausted: current ? page.exhausted : false,
    loadMore,
  };
}
