"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { EngineMessage, ListOlderOutcome, OhmailEngine, OhmailView } from "@ohmail/client-engine";

/**
 * The bottom of a pile, when the device holds only part of the mailbox: "this is your mail" or
 * "this is what this device kept". One ask per {@link OlderMail.loadMore} call, never on mount,
 * scroll or re-render — a prefetch would pull the mailbox into a mirror that does not want it.
 * Whether there is anything to ask for is the STORE's answer (`engine.storeCoverage()`), never
 * the window policy's. The rows are NOT mirror rows (no sync sequence): they live in this hook's
 * state and the engine's page cache, and the mirror's own row wins by id (it carries the overlay
 * and this device's triage). Keyed to one view: leaving and returning starts from the top.
 */

/** What the surface renders below its own rows. */
export interface OlderMail {
  /**
   * Is there anywhere further back to look?
   *
   * `false` for a client whose mirror IS the mailbox — the demo, and any client whose store
   * says this mirror holds every message it has. A list must render nothing at all in that case:
   * an affordance to load older mail, over a client that has every message already, is an offer
   * that cannot be kept.
   */
  available: boolean;
  /**
   * The store has not answered yet whether older mail exists: say nothing about the boundary.
   * The hook always states it; a surface handed an `OlderMail` without it reads "not pending".
   */
  pending?: boolean;
  /** Older messages fetched so far, mirror-preferred by id, in the server's order — arrival, as the list's own. */
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

/** Pages one press may walk past while every row they bring is one the list does not list. */
export const OLDER_HOPS = 8;
/** Rows a walked-past page asks for — the server's own page ceiling, so a walk spans 1,600 rows. */
export const OLDER_HOP_LIMIT = 200;

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
 * Error codes whose message is written for the person, not for a log. An allowlist, necessarily: a
 * server's error message is developer text by default — internal vocabulary, untranslated, written
 * for somebody who can change the request — and passing it through publishes the first refusal
 * nobody anticipated verbatim under a pile of mail (a validation message listing internal view
 * names did exactly that). The spend gate is the exception the list exists for: a 402 says what ran
 * out and what to do about it, and "could not be loaded" would take away the only thing that lets
 * the reader fix it. The rule: say nothing extra unless the server's sentence was addressed to the
 * reader.
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
   * The caller's mirror boundary — the OLDEST row the mirror renders for this scope, as an
   * arrival-key position (`storeKeyOf`: `sortAt ?? date`, id). Page one starts strictly below it,
   * so the reach-past never re-serves the rows on screen above it. Read once per scope.
   */
  startBelow?: { date: string | null; id: string },
  /**
   * "Must this fetched row stay out of the tail right now?" — asked per render, of the LIVE
   * mirror, never remembered (a filter against the surface's own list resurfaces a row moved out of
   * scope; a remembered discard makes mail vanish when the mirror later hard-prunes the live row).
   * Fetched copies are all kept; four verdicts: `"hide"` — the mirror positively shows the row in
   * this scope (the surface renders it; any latch clears); `"ban"` — the row has LEFT this scope:
   * the stale pre-move copy is latched out so a later hard-prune cannot revive it; `"hold"` — the
   * render cannot judge the scope (folder entity absent): row out, latch untouched — a defensive
   * hide is not an observation; `"show"` — not in the mirror (evicted or older): renders unless latched.
   */

  /**
   * The latch fires on observation and clears only on the opposite observation (a `"hide"`): the mirror is
   * overlay-aware, so a pending optimistic move also answers `"ban"`, and a hard-rejected move rolls the row back —
   * neither may leave a stale latch outliving a later eviction. `"hold"` is what makes the clear safe: without it,
   * defensive hides (folders toggled off and on over an open URL) would count as returns and release latches the
   * scope never re-earned; what happens inside such a gap is settled by `scopeEpoch` below. The one residual the
   * latch cannot close: a change applied and hard-pruned inside a single render tick of an open scope,
   * indistinguishable from eviction by any reader of the live mirror — named, not papered over.
   */
  suppress?: (id: string) => "show" | "hide" | "ban" | "hold",
  /**
   * The scope's epoch — bumped by the caller when the scope becomes judgeable again after a gap it
   * could not judge (the folder entity re-entering the mirror after a feature toggle). A bump is a
   * full reset: pages, cursor and latches drop and the tail re-earns its rows from the server. The
   * gap is genuinely unjudgeable: while the entity is absent every verdict is "hold", and a move
   * sequence ending in a window prune before the entity returns erases its own evidence — a banned
   * row moved back then pruned reads exactly like a shown row moved out then pruned, so any policy
   * that keeps state across the gap tells one of the two lies (three defects, one each). Refusing
   * to remember and re-asking the server is the only answer right in both directions.
   */
  scopeEpoch: number = 0,
  /**
   * WHICH OF THESE FETCHED ROWS THIS LIST PRESENTS — asked of the rows the mirror does not hold
   * (verdict `show`), in one batch, by the client's own partition. The server's page is a folder
   * listing, and the list is a presentation: a first-time sender's letter the Screener holds is in
   * the Ohbox's folder and not in the Ohbox. Absent ⇒ every `show` row belongs.
   */
  belongs?: (fetched: readonly EngineMessage[]) => ReadonlySet<string>,
): OlderMail {
  const coverage = engine.storeCoverage();
  const available = engine.listOlderAvailable() && coverage.state !== "whole";
  const pending = available && coverage.state === "unread";
  const [page, setPage] = useState<Page>(EMPTY);
  /* THE STORE IS ASKED, post-commit, whenever the engine says it is owed an answer — on mount, and
     again when the mirror stops matching a `whole` answer. The bump re-renders on the answer. */
  const [, setAsked] = useState(0);
  useEffect(() => {
    if (coverage.state !== "unread") return;
    let live = true;
    void engine.readStoreCoverage().then(() => { if (live) setAsked((n) => n + 1); });
    return () => { live = false; };
  }, [engine, coverage.state]);

  /** `suppress` behind a stable identity, so the memo's deps stay honest — consent-state's `link`. */
  const suppressRef = useRef<((id: string) => "show" | "hide" | "ban" | "hold") | undefined>(suppress);
  suppressRef.current = suppress;
  const belongsRef = useRef(belongs);
  belongsRef.current = belongs;
  /** The scope this hook's page state belongs to — see the SYNCHRONOUS reset below. */
  const scope = `${view}|${folderId ?? ""}|${scopeEpoch}`;

  /**
   * THE PAGING POSITION — cursor, in-flight, exhaustion and the ban latch — as ONE ref object KEYED BY ITS SCOPE, and
   * NEVER touched during render. A ref rather than state, for `loadMore`'s reasons: the callback is stable enough to
   * hang on a button, two same-tick asks must see each other's `inFlight`, and a `setState` updater must stay pure.
   * One OBJECT rather than parallel refs, because the object's identity is the response token: a page answered for
   * one incarnation is recognized by `paging.current !== p` and dropped, which no counter can get wrong. NEVER
   * MUTATED IN RENDER, and that is the review-earned part (three findings deep): React may discard a render pass —
   * StrictMode's replay, a concurrent render preempted and thrown away — and a discarded pass keeps its ref mutations
   * while losing its state updates.
   */

  /**
   * Any render-phase ref write therefore desyncs the two worlds: a speculative pass toward scope B that never commits
   * must not clear scope A's cursor, kill A's in-flight response (a loader with no answer and no retry), or wipe A's
   * latch. So the ref is reset LAZILY, by {@link pagingFor}, from event handlers and effects only — code that runs
   * strictly after a commit, on behalf of the scope that actually committed.
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
  /**
   * PUBLISHED DURING THE COMMIT — `useCommitEffect` (the browser's `useLayoutEffect`), not a passive `useEffect`, and
   * that is load-bearing twice over:
   * · the committed scope validates ASYNCHRONOUS answers, and a passive effect runs after paint — a response
   *   settling in that window was validated against the PREVIOUS commit's scope and queued into the new scope's
   *   freshly reset page. The layout phase runs synchronously inside the commit, before any microtask can observe it;
   */

  /**
   * · the previous paging incarnation is retired HERE, on every committed scope change — not lazily on the next ask
   *   — because an A→B→A round trip in which B never asks must not hand A back its old cursor (page one skipped),
   *   exhaustion (the empty-folder probe no-ops, silently), in-flight flag (the button dead until reload) or latch,
   *   beside a page state the round trip reset.
   */
  useCommitEffect(() => {
    committed.current = { scope, engine };
    void pagingFor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, scope]);

  /**
   * THE PAGE-STATE RESET, SYNCHRONOUS WITH THE RENDER THAT CHANGES THE SCOPE — deliberately not an effect, twice
   * over:
   * · deferred to an effect, it ran one render LATE, so the mismatch render needed a guard to keep the previous
   *   folder's rows from rendering under the new folder's title;
   * · worse, it ran AFTER children's effects — and the consumer that needs the reset most is exactly a child mount
   *   effect: FolderView mounts when a folder entity (re)enters the mirror and immediately probes an empty folder, so
   *   the probe read the PREVIOUS scope's paging state. A stale exhaustion swallowed it with no state change to ever
   *   re-run it.
   */

  /**
   * The render-phase `setPage` is React's documented adjust-state-during-render pattern; the guard is STATE (a
   * replayed render still sees the old `resetFor` and re-runs the block, where a ref guard desyncs — see `paging`),
   * and the block touches NOTHING but state: the paging ref belongs to post-commit code, and resets itself lazily
   * there.
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

    /* ONE PRESS BRINGS SOMETHING NEW. A page listing nothing (the store re-serving what this
       device holds, a held stranger's letters) is walked past, up to {@link OLDER_HOPS} pages of
       {@link OLDER_HOP_LIMIT}; every fetched row is kept either way, for the latch's reasons. */
    const shown = (items: readonly EngineMessage[]): boolean => {
      const open = items.filter((m) => (suppressRef.current?.(m.id) ?? "show") === "show" && !p.banned.has(m.id));
      const belong = open.length > 0 ? belongsRef.current?.(open) : undefined;
      return open.some((m) => belong === undefined || belong.has(m.id));
    };
    const ask = (cursor: string | null, hop: number, got: EngineMessage[]): Promise<ListOlderOutcome> => engine
      .listOlder(view, {
        ...(cursor ? { cursor } : {}),
        ...(folderId ? { folderId } : {}),
        ...(!cursor && startBelow ? { startBelow } : {}),
        ...(hop > 0 ? { limit: OLDER_HOP_LIMIT } : {}),
      })
      .then((outcome): Promise<ListOlderOutcome> | ListOlderOutcome => {
        if (outcome.state !== "ready") return got.length === 0 ? outcome : { state: "ready", items: got, nextCursor: cursor };
        const have = new Set(got.map((m) => m.id));
        const items = [...got, ...outcome.items.filter((m) => !have.has(m.id))];
        const stale = paging.current !== p || committed.current.scope !== p.scope;
        if (!stale && outcome.nextCursor !== null && hop + 1 < OLDER_HOPS && !shown(outcome.items)) {
          return ask(outcome.nextCursor, hop + 1, items);
        }
        return { state: "ready", items, nextCursor: outcome.nextCursor };
      });
    void ask(p.cursor, 0, [])
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
    const open = page.items
      // The per-render verdicts — see `suppress`: anything but "show" stays out of the tail
      // right now ("hide" because the surface renders it, "ban" because the mirror says it
      // left, "hold" because the scope is unreadable), and "show" still defers to the latch.
      .filter((item) => {
        const verdict = suppressRef.current?.(item.id) ?? "show";
        if (verdict !== "show") return false;
        return !(latched?.has(item.id) ?? false);
      });
    // And the list's own partition, over what is left: never latched, asked again every render.
    const belong = open.length > 0 ? belongsRef.current?.(open) : undefined;
    // The row as it stands now: the mirror's, else the page cache's (a pressed verb's effect, or
    // the store's later word after the window pruned it again); a row the mirror records gone drops.
    return open
      .filter((item) => belong === undefined || belong.has(item.id))
      .map((item) => reader.get<EngineMessage>("message", item.id) ?? engine.storePageRow(item))
      .filter((m): m is EngineMessage => m !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, page.items, version, scope]);

  // The synchronous reset above means the page state is ALWAYS the current scope's by the
  // time this returns — the mismatch guard that used to live here guarded a reset that ran
  // one render late, and the render-phase `setPage(EMPTY)` re-runs this hook before anything
  // renders the previous scope's rows.
  return {
    available,
    pending,
    items,
    loading: page.loading,
    error: page.error,
    exhausted: page.exhausted,
    loadMore,
  };
}
