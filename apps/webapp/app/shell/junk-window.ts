"use client";

/**
 * THE JUNK WINDOW'S CLIENT STATE — a live, un-mirrored view of the provider's own \Junk
 * (FOLDERS-SPEC.md §16.2), behind "Use folders".
 *
 * ── WHY THIS IS NOT IN `screener-state.ts` ────────────────────────────────────────────────
 *
 * Everything that hook holds comes from the MESSAGE MIRROR, and the whole point of the Junk
 * window is that Junk never enters it: the segment reads the folder itself, on request, through
 * `GET /screener/junk`. So this module owns the asking — one page on segment entry, explicit
 * "Show older" pagination, a body per open — and holds what it learned for THIS SESSION only.
 * Closing the app forgets it; nothing here writes to the mirror, and nothing the mirror does can
 * make this data stale in a way a reload of the window would not fix.
 *
 * ── THE HONEST STATES (§16.2's table) ─────────────────────────────────────────────────────
 *
 * A window that cannot read SAYS SO: `phase: "failed"` renders the failed sentence and a retry,
 * never an empty list — an empty list is the answer "your Junk is empty", which a dead dial has
 * no business claiming. Per-mailbox degrades ride the answer itself (`window: "no_junk_folder" |
 * "unreachable"`), so an account whose one mailbox has no native \Junk gets the stated absence
 * rather than an error.
 *
 * ── THE RESCUE, AND ITS SECOND VERB ───────────────────────────────────────────────────────
 *
 * "Not junk" is ONE server-side move out of Junk (the un-training gesture); the message then
 * re-enters through the NORMAL pipeline — a first-time sender waits in the Screener, an allowed
 * one lands in the Ohbox. The row leaves this list on success. A 410 — the provider removed the
 * message first — also removes the row (it IS gone from Junk) but says what happened; any other
 * failure keeps the row and says so, because a row that silently vanished on a failed rescue
 * would be this window inventing the provider's state.
 *
 * "Not junk, always allow" (`rescue(item, { allow: true })`) is the same press plus one statement
 * about the SENDER: the server switches off their spam-promoting rule and mints their allow before
 * the move (junk-window.ts on the API side argues both halves). The sentences differ because the
 * outcomes differ — and on a 410 the allow still stands, so that sentence says both.
 *
 * ── THE SEARCH-APPEND (§16.2's table: "async search-append with a timeout") ───────────────
 *
 * Typing filters the LOADED window instantly and locally — no request. Only when that filter
 * finds nothing does the hook ask the server (`GET /screener/junk/search`, debounced, once per
 * settled query), and the hits are APPENDED under whatever the local filter kept: `visible` is
 * the one list the view renders, so a server hit is selectable, openable and rescuable exactly
 * like a loaded row. The first paint never waits on the search; a mailbox that did not answer in
 * time is stated ("could not be searched"), and a search that found nothing says so plainly —
 * never a spinner that outlives its promise.
 *
 * ── THE ONE-TIME SWEEP OFFER (§16.1) ───────────────────────────────────────────────────
 *
 * With the window's first page the hook also reads the sweep PREVIEW — how much mail from
 * earlier verdicts still sits in `ohmail/Quarantine`, invisible from this segment now that it
 * reads native Junk. Above zero, the segment offers the one press; the press records the
 * command (`POST /screener/junk/sweep`) and the worker executes it, so the offer shows "queued"
 * and polls the preview until the pile is empty ("done"). "Never offered twice unless there is
 * new content" is the candidate count itself: a dismissal remembers the count it dismissed
 * (`localStorage`, per browser), and the offer returns only when the pile has GROWN past it.
 *
 * ── THE WIRE IS A SEAM ────────────────────────────────────────────────────────────────────
 *
 * Every call goes through {@link JunkWire}. Absent, it is the browser's Cloud client — gated on
 * `apiConfigured()`, answered by the module that owns the client (the shared shell never imports
 * it). The desktop hands in its bridge (`local-junk.ts`): its window aliases the Cloud client to
 * a refusing stub, and on its hosted door the engine forwards these routes to the account. The
 * STATES and their sentences are decided above the seam and cannot vary by wire — the
 * `ConsentTransport` rule.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ToastFn } from "@ohmail/ui";
import {
  ApiError, apiConfigured, screener as screenerApi,
  type JunkItemWire, type JunkMailboxWire, type JunkPageWire, type JunkRescueWire,
  type JunkSearchWire, type JunkSweepWire,
} from "../api-client";

/**
 * One row's stable key. EPOCH-SCOPED: a UID names a message only within one UIDVALIDITY, so a
 * key without the epoch would alias a recreated folder's reused numbers onto the old rows'
 * selection and session body cache — the stale body under the new subject.
 */
export const junkKeyOf = (i: { mailboxId: string; uidValidity: string; uid: number }): string =>
  `${i.mailboxId}:${i.uidValidity}:${i.uid}`;

/** The six calls the window makes, behind one seam a host can replace with its own transport. */
export interface JunkWire {
  list(opts?: { cursor?: string }): Promise<JunkPageWire>;
  body(mailboxId: string, uid: number, uidValidity: string): Promise<{ subject: string; text: string }>;
  rescue(mailboxId: string, uid: number, uidValidity: string, opts?: { allow?: { sender: string } }): Promise<JunkRescueWire>;
  search(q: string): Promise<JunkSearchWire>;
  sweepPreview(): Promise<JunkSweepWire>;
  sweepRequest(): Promise<JunkSweepWire>;
  /**
   * A wire's 410 — the row is gone from Junk — must be recognisable above the seam: the
   * browser's client throws `ApiError` with the status, a host wire answers this predicate.
   */
  isGone(err: unknown): boolean;
}

/** The browser's wire: the Cloud client, verbatim. */
const cloudWire: JunkWire = {
  list: (opts) => screenerApi.junkList(opts),
  body: (m, u, v) => screenerApi.junkBody(m, u, v),
  rescue: (m, u, v, opts) => screenerApi.junkRescue(m, u, v, opts),
  search: (q) => screenerApi.junkSearch(q),
  sweepPreview: () => screenerApi.junkSweepPreview(),
  sweepRequest: () => screenerApi.junkSweepRequest(),
  isGone: (err) => err instanceof ApiError && err.status === 410,
};

export type JunkBodyPhase =
  | { phase: "idle" }
  /**
   * `attempt` numbers each ask for one row, so the preview can REMOUNT its body anatomy per
   * try — a retry that reused the mount kept the expired stall timer's "failed" face over the
   * live second request (review round on the retry).
   */
  | { phase: "loading"; attempt: number }
  | { phase: "ready"; text: string }
  | { phase: "failed" };

/** The search-append's state — see the module header. */
export interface JunkSearchControl {
  query: string;
  setQuery: (q: string) => void;
  /**
   * `idle` — no query; `local` — the loaded window is filtered and the server has not been
   * asked (it is asked automatically when the filter finds nothing, or on the human press);
   * `searching` — a server search is in flight; `done` — it answered (hits may be empty);
   * `failed` — the request itself failed (a per-mailbox timeout is NOT this: it answers `done`
   * with that mailbox stated `unreachable`).
   */
  phase: "idle" | "local" | "searching" | "done" | "failed";
  /** Server hits NOT already among the locally-kept rows. */
  hits: JunkItemWire[];
  /** How many of `visible` are locally-kept rows — the server's appended hits begin after them. */
  localCount: number;
  /** Per-mailbox states of the last server search — an `unreachable` one "could not be searched". */
  mailboxes: JunkMailboxWire[];
  truncated: boolean;
  /** Ask the server for THIS query now — the human press behind `local`, or a retry after `failed`. */
  searchServer: () => void;
}

/** The one-time sweep offer's state — see the module header. */
export interface JunkSweepControl {
  /**
   * `unknown` — not read yet (or the read failed: no offer is made on a guess); `none` — nothing
   * to offer (empty pile, or dismissed at this size); `offer` — the pile is shown with its
   * number; `pending` — pressed, the worker has not emptied it yet; `done` — emptied after a
   * press this session; `failed` — the press itself could not be recorded.
   */
  phase: "unknown" | "none" | "offer" | "pending" | "done" | "failed";
  preview: JunkSweepWire | null;
  requesting: boolean;
  request: () => void;
  dismiss: () => void;
}

export interface JunkWindowControl {
  /**
   * IS THERE A SERVER BEHIND THIS CONTROL — `apiConfigured()` for the browser's wire, `true`
   * for a host-supplied one. The shell passes the control to the view only when this is true:
   * the hosted DESKTOP aliases the api client to a refusing stub while its suggest wire makes
   * the broader "is there a server to ask" read true, and a control wired to a stub rendered a
   * permanent loading state over the hidden Spam segment (review finding on this commit).
   */
  supported: boolean;
  /** The list read's own state — `failed` is rendered as failed, never as empty. */
  phase: "loading" | "ready" | "failed";
  /** The loaded window — the newest page plus whatever "Show older" appended. */
  items: JunkItemWire[];
  /**
   * WHAT THE VIEW RENDERS: `items` with no query; with one, the locally-kept rows followed by
   * the server's hits. Selection, body-on-open and the rescue all address rows from THIS list.
   */
  visible: JunkItemWire[];
  mailboxes: JunkMailboxWire[];
  nextCursor: string | null;
  olderLoading: boolean;
  /** Re-ask after a failure (a human press), or refresh the window. */
  reload: () => void;
  loadOlder: () => void;
  /** The session body cache: opening twice costs one fetch; closing the app forgets it. */
  bodyFor: (item: JunkItemWire) => JunkBodyPhase;
  /**
   * Fetch the body on open. `retry: true` REPLACES whatever the cache holds — the human's
   * Retry after a stall must dispatch even while a hung first ask still shows `loading`
   * (review finding: the automatic open refuses non-failed entries, so Retry did nothing).
   */
  openBody: (item: JunkItemWire, opts?: { retry?: boolean }) => void;
  /**
   * "Not junk" — the rescue. The row leaves the list when the server confirmed the move.
   * `allow: true` is the second verb — "Not junk, always allow" — same press, plus the sender's
   * rules (their spam rule off, their allow minted) written before the move.
   */
  rescue: (item: JunkItemWire, opts?: { allow?: boolean }) => void;
  rescuing: (item: JunkItemWire) => boolean;
  search: JunkSearchControl;
  sweep: JunkSweepControl;
}

/** Case-folded substring over subject, sender name and address — the local filter's whole rule. */
export function junkRowMatches(item: JunkItemWire, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return item.subject.toLowerCase().includes(q)
    || item.from.address.toLowerCase().includes(q)
    || (item.from.name?.toLowerCase().includes(q) ?? false);
}

/** How long a typed query rests before the server is asked for it. */
export const JUNK_SEARCH_DEBOUNCE_MS = 450;
/** How often the queued sweep re-reads its preview, and for how long, before it stops asking. */
export const JUNK_SWEEP_POLL_MS = 5_000;
export const JUNK_SWEEP_POLL_MAX = 36;
/** The per-browser memory of a dismissed offer: the candidate count it was dismissed at. */
export const JUNK_SWEEP_DISMISSED_KEY = "ohmail.junkSweepDismissedAt";

function readDismissed(): number {
  try {
    const raw = window.localStorage.getItem(JUNK_SWEEP_DISMISSED_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * The window's state machine. `active` is "the Junk segment is on screen AND the feature is on":
 * the first page loads lazily on entry and stays for the session; nothing is fetched while the
 * flag is off or the view is elsewhere.
 */
export function useJunkWindow(active: boolean, toast: ToastFn, hostWire?: JunkWire): JunkWindowControl {
  const t = useTranslations("screener");
  const wire = hostWire ?? cloudWire;
  const supported = hostWire !== undefined || apiConfigured();
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<JunkItemWire[]>([]);
  const [boxes, setBoxes] = useState<JunkMailboxWire[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [bodies, setBodies] = useState<Map<string, JunkBodyPhase>>(() => new Map());
  /** Per-row ask generation — a superseded ask's completion must not overwrite its successor's. */
  const bodyGen = useRef(new Map<string, number>());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  /** Has THIS session read page one yet? Lazily, once, on segment entry. */
  const asked = useRef(false);
  /** A stale page must not land over a newer reload's answer. */
  const generation = useRef(0);

  const fetchFirst = useCallback(() => {
    if (!supported) {
      // No server behind this build: the honest resting state, never an eternal spinner. The
      // shell also withholds the control entirely on `supported`, so this is the belt.
      setPhase("failed");
      return;
    }
    const gen = ++generation.current;
    setPhase("loading");
    void wire.list().then(
      (page) => {
        if (generation.current !== gen) return;
        setItems(page.items);
        setBoxes(page.mailboxes);
        setNextCursor(page.nextCursor);
        setPhase("ready");
      },
      () => {
        if (generation.current !== gen) return;
        // FAILED, not empty — the §16.2 rule. The retry is the human's, not a loop's.
        setPhase("failed");
      },
    );
  }, [supported, wire]);

  useEffect(() => {
    if (!active || asked.current) return;
    asked.current = true;
    fetchFirst();
  }, [active, fetchFirst]);

  const reload = useCallback(() => {
    asked.current = true;
    fetchFirst();
  }, [fetchFirst]);

  const loadOlder = useCallback(() => {
    if (nextCursor === null || olderLoading) return;
    setOlderLoading(true);
    void wire.list({ cursor: nextCursor }).then(
      (page) => {
        setOlderLoading(false);
        /**
         * AN EPOCH RESET IS A RESTART, NOT AN APPEND. The server STATES which mailbox's cursor
         * it discarded (`reset` on the mailbox row — stated, not inferred, because a reset
         * folder that is now EMPTY contributes no row to infer from). That mailbox's rows in
         * this answer are its new TOP page; appending them under the old rows would file the
         * folder's newest mail at the bottom of the window, and splicing per mailbox would
         * leave the OTHER mailboxes' pages half-consumed. So the window starts over with a
         * real cursorless first page — `reload()` — which is correct for every mailbox at
         * once (round 3's finding on the single-mailbox restart).
         */
        if (page.mailboxes.some((m) => m.reset === true)) {
          fetchFirst();
          return;
        }
        setItems((cur) => {
          // Appended, never re-sorted: the reader asked for OLDER, below what they have.
          const have = new Set(cur.map(junkKeyOf));
          return [...cur, ...page.items.filter((i) => !have.has(junkKeyOf(i)))];
        });
        setNextCursor(page.nextCursor);
      },
      () => {
        setOlderLoading(false);
        toast(t("junkFailed"));
      },
    );
  }, [nextCursor, olderLoading, toast, t, fetchFirst, wire]);

  const bodyFor = useCallback(
    (item: JunkItemWire): JunkBodyPhase => bodies.get(junkKeyOf(item)) ?? { phase: "idle" },
    [bodies],
  );

  const openBody = useCallback((item: JunkItemWire, opts: { retry?: boolean } = {}) => {
    const key = junkKeyOf(item);
    setBodies((cur) => {
      const held = cur.get(key);
      // One fetch per session per message — `ready` and in-flight `loading` are both answers.
      // A human RETRY overrides both: a hung first ask still reads `loading`, and refusing
      // the press would leave Retry dead until a reload.
      if (!opts.retry && held && held.phase !== "failed") return cur;
      // Each ask takes the row's NEXT generation; a completion landing after a newer ask took
      // over is DROPPED — a hung first request's late rejection must not overwrite the
      // retry's delivered body with "failed" (review round on the retry).
      const gen = (bodyGen.current.get(key) ?? 0) + 1;
      bodyGen.current.set(key, gen);
      void wire.body(item.mailboxId, item.uid, item.uidValidity).then(
        (b) => setBodies((m) =>
          bodyGen.current.get(key) === gen ? new Map(m).set(key, { phase: "ready", text: b.text }) : m),
        () => setBodies((m) =>
          bodyGen.current.get(key) === gen ? new Map(m).set(key, { phase: "failed" }) : m),
      );
      return new Map(cur).set(key, { phase: "loading", attempt: gen });
    });
  }, [wire]);

  /* ── THE SEARCH-APPEND ─────────────────────────────────────────────────────────────────── */
  const [query, setQueryState] = useState("");
  const [searchPhase, setSearchPhase] = useState<JunkSearchControl["phase"]>("idle");
  const [hits, setHits] = useState<JunkItemWire[]>([]);
  const [searchBoxes, setSearchBoxes] = useState<JunkMailboxWire[]>([]);
  const [truncated, setTruncated] = useState(false);
  /** The query a server answer belongs to — a late answer for an older query is dropped. */
  const searchGen = useRef(0);
  /** The queries this session already asked the server about — one ask per settled query. */
  const askedServer = useRef(new Set<string>());

  const localKept = useMemo(
    () => (query.trim().length === 0 ? items : items.filter((i) => junkRowMatches(i, query))),
    [items, query],
  );

  const searchServer = useCallback((q?: string) => {
    const term = (q ?? query).trim();
    if (term.length === 0) return;
    askedServer.current.add(term);
    const gen = ++searchGen.current;
    setSearchPhase("searching");
    void wire.search(term).then(
      (page) => {
        if (searchGen.current !== gen) return;
        setHits(page.items);
        setSearchBoxes(page.mailboxes);
        setTruncated(page.truncated);
        setSearchPhase("done");
      },
      () => {
        if (searchGen.current !== gen) return;
        setHits([]);
        setSearchBoxes([]);
        setTruncated(false);
        setSearchPhase("failed");
      },
    );
  }, [query, wire]);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    // A NEW query voids the last answer: hits for the old words under the new filter would be
    // the window claiming a match it never checked.
    searchGen.current += 1;
    setHits([]);
    setSearchBoxes([]);
    setTruncated(false);
    setSearchPhase(q.trim().length === 0 ? "idle" : "local");
  }, []);

  useEffect(() => {
    // The automatic kick — ONLY when the local filter found nothing, ONLY once the typing has
    // rested, and ONLY once per query this session. A human press (`searchServer`) is the way
    // to ask again, or to ask while local rows do match.
    const term = query.trim();
    if (term.length === 0 || phase !== "ready") return;
    if (localKept.length > 0 || askedServer.current.has(term)) return;
    const timer = setTimeout(() => searchServer(term), JUNK_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, phase, localKept.length, searchServer]);

  const visible = useMemo(() => {
    if (query.trim().length === 0) return items;
    const have = new Set(localKept.map(junkKeyOf));
    return [...localKept, ...hits.filter((h) => !have.has(junkKeyOf(h)))];
  }, [items, query, localKept, hits]);

  /* ── THE RESCUE (both verbs) ───────────────────────────────────────────────────────────── */
  const dropRow = useCallback((key: string) => {
    setItems((cur) => cur.filter((i) => junkKeyOf(i) !== key));
    setHits((cur) => cur.filter((i) => junkKeyOf(i) !== key));
  }, []);

  const rescue = useCallback((item: JunkItemWire, opts: { allow?: boolean } = {}) => {
    const key = junkKeyOf(item);
    const allow = opts.allow === true;
    setBusy((cur) => new Set(cur).add(key));
    void wire.rescue(item.mailboxId, item.uid, item.uidValidity, allow ? { allow: { sender: item.from.address } } : {}).then(
      () => {
        setBusy((cur) => { const n = new Set(cur); n.delete(key); return n; });
        // CONFIRMED first, removed second — the row leaves only for a move that happened.
        dropRow(key);
        toast(t(allow ? "junkRescuedAllowed" : "junkRescued"));
      },
      (err: unknown) => {
        setBusy((cur) => { const n = new Set(cur); n.delete(key); return n; });
        if (wire.isGone(err)) {
          // The provider (or another client) removed it first. It IS out of Junk — the row
          // goes — but the sentence says what happened rather than claiming our move did it.
          // With the second verb the allow was written BEFORE the move and stands: said too.
          dropRow(key);
          toast(t(allow ? "junkRescueGoneAllowed" : "junkRescueGone"));
          return;
        }
        toast(t("junkRescueFailed"));
      },
    );
  }, [toast, t, wire, dropRow]);

  const rescuing = useCallback((item: JunkItemWire) => busy.has(junkKeyOf(item)), [busy]);

  /* ── THE ONE-TIME SWEEP OFFER ──────────────────────────────────────────────────────────── */
  const [sweepPhase, setSweepPhase] = useState<JunkSweepControl["phase"]>("unknown");
  const [sweepPreview, setSweepPreview] = useState<JunkSweepWire | null>(null);
  const [requesting, setRequesting] = useState(false);
  const sweepAsked = useRef(false);
  /** Set once the human pressed THIS session — what turns an emptied pile into "done". */
  const pressed = useRef(false);

  const absorbPreview = useCallback((pv: JunkSweepWire) => {
    setSweepPreview(pv);
    if (pv.movable === 0) {
      setSweepPhase(pressed.current ? "done" : "none");
    } else if (pv.pending) {
      setSweepPhase("pending");
    } else {
      // Offered only when the pile has GROWN past the size it was dismissed at.
      setSweepPhase(pv.movable > readDismissed() ? "offer" : "none");
    }
  }, []);

  useEffect(() => {
    if (!active || !supported || sweepAsked.current) return;
    sweepAsked.current = true;
    void wire.sweepPreview().then(absorbPreview, () => {
      // A failed read makes NO offer — `unknown` renders nothing rather than a guess.
      setSweepPhase("unknown");
    });
  }, [active, supported, wire, absorbPreview]);

  // While a press is outstanding, re-read the preview on a slow beat until the pile is empty
  // (or the beat runs out — the offer then keeps saying "queued", which is still true).
  useEffect(() => {
    if (sweepPhase !== "pending") return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > JUNK_SWEEP_POLL_MAX) { clearInterval(timer); return; }
      void wire.sweepPreview().then(absorbPreview, () => { /* keep the last known state */ });
    }, JUNK_SWEEP_POLL_MS);
    return () => clearInterval(timer);
  }, [sweepPhase, wire, absorbPreview]);

  const request = useCallback(() => {
    if (requesting) return;
    setRequesting(true);
    pressed.current = true;
    void wire.sweepRequest().then(
      (pv) => { setRequesting(false); absorbPreview(pv); },
      () => { setRequesting(false); setSweepPhase("failed"); },
    );
  }, [requesting, wire, absorbPreview]);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(JUNK_SWEEP_DISMISSED_KEY, String(sweepPreview?.movable ?? 0));
    } catch { /* storage blocked — the dismissal lasts the session */ }
    setSweepPhase("none");
  }, [sweepPreview]);

  return {
    supported,
    phase, items, visible, mailboxes: boxes, nextCursor, olderLoading,
    reload, loadOlder, bodyFor, openBody, rescue, rescuing,
    search: {
      query, setQuery, phase: searchPhase, hits, localCount: localKept.length,
      mailboxes: searchBoxes, truncated,
      searchServer: () => searchServer(),
    },
    sweep: { phase: sweepPhase, preview: sweepPreview, requesting, request, dismiss },
  };
}
