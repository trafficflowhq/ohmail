"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

/** One scope's paging position — see the `paging` ref inside {@link useOlderMail}. */
interface Paging {
  scope: string;
  engine: OhmailEngine;
  cursor: string | null;
  inFlight: boolean;
  done: boolean;
  /** Ids OBSERVED leaving the scope — the `"ban"` latch. See `suppress`. */
  banned: Set<string>;
}

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

/**
 * `useLayoutEffect` in a browser; `useEffect` where there is nothing to lay out — `engine.tsx`'s
 * `useAfterHydration`, chosen ONCE at module scope for the same two reasons: hooks must be the
 * same hook on every render, and a bare `useLayoutEffect` in a server render is a
 * `console.error` (Next pre-renders client components), which the zero-console-errors rule
 * refuses. On the server there is no commit, no paint and no microtask racing a response, so
 * the passive fallback loses nothing there; in the browser the layout phase is the point — see
 * the commit-scope effect below.
 */
const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

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
   * So the fetched copies are all KEPT, and this predicate answers per render with FOUR
   * verdicts, because eviction, an authoritative removal, and a render that cannot judge the
   * scope must not read alike:
   *
   *  · `"hide"` — the mirror POSITIVELY shows the row in this scope (the surface above renders
   *    it); the tail stays quiet, and any latch on the id clears — see below;
   *  · `"ban"`  — the mirror shows the row has LEFT this scope (moved elsewhere): the fetched
   *    pre-move copy is stale by the mirror's word, and the id is latched out, so a LATER
   *    hard-prune of the moved row cannot revive it here;
   *  · `"hold"` — the render CANNOT JUDGE the scope (the folder entity is not in the mirror —
   *    the flag mid-toggle, a tombstone render): the row stays out of the tail and the latch
   *    is left exactly as it was, because a defensive hide is not an observation;
   *  · `"show"` — the mirror does not hold the row: evicted by the window's policy, or
   *    genuinely older mail. The fetched copy renders (unless latched).
   *
   * The latch fires on OBSERVATION — a render that sees the moved row — and it CLEARS only on
   * the OPPOSITE observation: a `"hide"`, the mirror holding the row in this scope again. The
   * clear exists because the mirror the caller reads is overlay-aware and a pending optimistic
   * move also answers `"ban"` — a hard-rejected move rolls the row back into the scope, and a
   * row can be genuinely moved back, and neither may leave a stale latch that outlives a later
   * eviction. `"hold"` is the reason the clear is safe: without it, the caller's defensive
   * hides (folders toggled off and on over an open URL) would count as returns and release
   * latches the scope never re-earned. What happens INSIDE such a gap is settled by
   * `scopeEpoch` below — nothing is judged, and the gap's end resets the tail — because moves
   * that end in a prune during the gap erase their own evidence. The one residual the latch
   * cannot close is a change applied and hard-pruned inside a single render tick of an open
   * scope, which no reader of the live mirror can distinguish from eviction; named here
   * rather than papered over.
   */
  suppress?: (id: string) => "show" | "hide" | "ban" | "hold",
  /**
   * THE SCOPE'S EPOCH — bumped by the caller when the scope becomes JUDGEABLE again after a
   * gap it could not judge (the folder entity re-entering the mirror after a feature toggle).
   * A bump is a full reset: pages, cursor and latches are dropped and the tail re-earns its
   * rows from the server, whose next pages are the authority the gap withheld.
   *
   * This exists because the gap is genuinely unjudgeable, not merely awkward. While the
   * entity is absent every verdict is `"hold"`, and any move sequence that ends in a window
   * prune before the entity returns erases its own evidence — a banned row moved back then
   * pruned reads exactly like a shown row moved out then pruned, so ANY policy that keeps
   * state across the gap tells one of the two lies (three review rounds each caught one).
   * Refusing to remember and re-asking the server is the only answer that is right in both
   * directions.
   */
  scopeEpoch: number = 0,
): OlderMail {
  const available = engine.listOlderAvailable();
  const [page, setPage] = useState<Page>(EMPTY);

  /** `suppress` behind a stable identity, so the memo's deps stay honest — consent-state's `link`. */
  const suppressRef = useRef<((id: string) => "show" | "hide" | "ban" | "hold") | undefined>(suppress);
  suppressRef.current = suppress;
  /** The scope this hook's page state belongs to — see the SYNCHRONOUS reset below. */
  const scope = `${view}|${folderId ?? ""}|${scopeEpoch}`;

  /**
   * THE PAGING POSITION — cursor, in-flight, exhaustion and the ban latch — as ONE ref object
   * KEYED BY ITS SCOPE, and NEVER touched during render.
   *
   * A ref rather than state, for `loadMore`'s reasons: the callback is stable enough to hang on
   * a button, two same-tick asks must see each other's `inFlight`, and a `setState` updater must
   * stay pure. One OBJECT rather than parallel refs, because the object's identity is the
   * response token: a page answered for one incarnation is recognized by `paging.current !== p`
   * and dropped, which no counter can get wrong.
   *
   * NEVER MUTATED IN RENDER, and that is the review-earned part (three findings deep): React
   * may discard a render pass — StrictMode's replay, a concurrent render preempted and thrown
   * away — and a discarded pass keeps its ref mutations while losing its state updates. Any
   * render-phase ref write therefore desyncs the two worlds: a speculative pass toward scope B
   * that never commits must not clear scope A's cursor, kill A's in-flight response (a loader
   * with no answer and no retry), or wipe A's latch. So the ref is reset LAZILY, by
   * {@link pagingFor}, from event handlers and effects only — code that runs strictly after a
   * commit, on behalf of the scope that actually committed.
   */
  const paging = useRef<Paging | null>(null);
  /** The committed scope — the response validator's second half. See the layout effect below. */
  const committed = useRef<{ scope: string; engine: OhmailEngine }>({ scope, engine });
  /** POST-COMMIT ONLY (see `paging`): the current scope's paging state, reset lazily on entry. */
  const pagingFor = (): Paging => {
    const p = paging.current;
    if (p === null || p.scope !== scope || p.engine !== engine) {
      paging.current = { scope, engine, cursor: null, inFlight: false, done: false, banned: new Set() };
    }
    return paging.current!;
  };
  /*
   * PUBLISHED DURING THE COMMIT — `useCommitEffect` (the browser's `useLayoutEffect`), not a
   * passive `useEffect`, and that is load-bearing twice over:
   *
   *  · the committed scope validates ASYNCHRONOUS answers, and a passive effect runs after
   *    paint — a response settling in that window was validated against the PREVIOUS commit's
   *    scope and queued into the new scope's freshly reset page. The layout phase runs
   *    synchronously inside the commit, before any microtask can observe it;
   *  · the previous paging incarnation is retired HERE, on every committed scope change — not
   *    lazily on the next ask — because an A→B→A round trip in which B never asks must not
   *    hand A back its old cursor (page one skipped), exhaustion (the empty-folder probe
   *    no-ops, silently), in-flight flag (the button dead until reload) or latch, beside a
   *    page state the round trip reset.
   */
  useCommitEffect(() => {
    committed.current = { scope, engine };
    void pagingFor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, scope]);

  /*
   * THE PAGE-STATE RESET, SYNCHRONOUS WITH THE RENDER THAT CHANGES THE SCOPE — deliberately
   * not an effect, twice over:
   *
   *  · deferred to an effect, it ran one render LATE, so the mismatch render needed a guard to
   *    keep the previous folder's rows from rendering under the new folder's title;
   *  · worse, it ran AFTER children's effects — and the consumer that needs the reset most is
   *    exactly a child mount effect: FolderView mounts when a folder entity (re)enters the
   *    mirror and immediately probes an empty folder, so the probe read the PREVIOUS scope's
   *    paging state. A stale exhaustion swallowed it with no state change to ever re-run it.
   *
   * The render-phase `setPage` is React's documented adjust-state-during-render pattern; the
   * guard is STATE (a replayed render still sees the old `resetFor` and re-runs the block,
   * where a ref guard desyncs — see `paging`), and the block touches NOTHING but state: the
   * paging ref belongs to post-commit code, and resets itself lazily there.
   */
  const [resetFor, setResetFor] = useState<{ scope: string; engine: OhmailEngine }>({ scope, engine });
  if (resetFor.scope !== scope || resetFor.engine !== engine) {
    setResetFor({ scope, engine });
    setPage(EMPTY);
  }

  const loadMore = useCallback(() => {
    if (!available) return;
    const p = pagingFor();
    if (p.inFlight || p.done) return;
    p.inFlight = true;
    setPage((prev) => ({ ...prev, loading: true, error: null }));

    void engine
      .listOlder(view, {
        ...(p.cursor ? { cursor: p.cursor } : {}),
        ...(folderId ? { folderId } : {}),
        ...(!p.cursor && startBelow ? { startBelow } : {}),
      })
      .then((outcome) => {
        // The answer counts only if THIS paging incarnation is still the live one AND its scope
        // is still the committed scope — a response for a list the UI has left changes nothing
        // (its page state was already reset by the scope's own render).
        if (paging.current !== p) return;
        if (committed.current.scope !== p.scope || committed.current.engine !== p.engine) return;
        p.inFlight = false;
        if (outcome.state === "unavailable") {
          p.done = true;
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
        p.cursor = outcome.nextCursor;
        p.done = outcome.nextCursor === null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, view, available, folderId, startBelow, scope]);

  /**
   * THE LATCH'S BOOKKEEPING, POST-COMMIT — the observations themselves happen in the memo
   * below (per render, of the live mirror), but WRITING them into the ban set is deferred to
   * this effect, because a discarded render's observations were never shown to anyone and must
   * not move the latch (see `paging`). Between this commit and the next render the memo reads
   * the previous commit's latch, which is exactly right: this render's "ban"s and "hide"s are
   * already enforced by their own verdicts; the latch exists for FUTURE renders, and futures
   * only follow commits.
   */
  useEffect(() => {
    if (page.items.length === 0) return;
    const p = pagingFor();
    for (const item of page.items) {
      const verdict = suppressRef.current?.(item.id) ?? "show";
      if (verdict === "ban") p.banned.add(item.id);
      else if (verdict === "hide") p.banned.delete(item.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, page.items, version, scope]);

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
    // The COMMITTED latch, read-only — this render's own "ban"/"hide" verdicts already hide
    // their rows below; the set carries past observations forward, and is written only by the
    // post-commit effect above. A paging object from another scope contributes nothing.
    const p = paging.current;
    const latched = p !== null && p.scope === scope && p.engine === engine ? p.banned : undefined;
    return page.items
      // The per-render verdicts — see `suppress`: anything but "show" stays out of the tail
      // right now ("hide" because the surface renders it, "ban" because the mirror says it
      // left, "hold" because the scope is unreadable), and "show" still defers to the latch.
      .filter((item) => {
        const verdict = suppressRef.current?.(item.id) ?? "show";
        if (verdict !== "show") return false;
        return !(latched?.has(item.id) ?? false);
      })
      .map((item) => reader.get<EngineMessage>("message", item.id) ?? item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, page.items, version, scope]);

  // The synchronous reset above means the page state is ALWAYS the current scope's by the
  // time this returns — the mismatch guard that used to live here guarded a reset that ran
  // one render late, and the render-phase `setPage(EMPTY)` re-runs this hook before anything
  // renders the previous scope's rows.
  return {
    available,
    items,
    loading: page.loading,
    error: page.error,
    exhausted: page.exhausted,
    loadMore,
  };
}
