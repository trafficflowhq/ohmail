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
import { createSessionBodyDoor, type SessionBodyHeld } from "@ohmail/client-engine";
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
  /** The server's error CODE, when the wire carried one — `junk_rescue_move_failed` is read above the seam. */
  codeOf(err: unknown): string | null;
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
  codeOf: (err) => (err instanceof ApiError ? err.code : null),
};

/** What one settled junk-body ask holds — the wire's own answer, subject included. */
type JunkBodyWireAnswer = { subject: string; text: string };

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
   * press this session; `stranded` — candidates remain but NONE can move (every mailbox that
   * holds them has no Junk folder), so there is nothing to press and "empty" would be a lie;
   * `failed` — the press itself could not be recorded.
   */
  phase: "unknown" | "none" | "offer" | "pending" | "done" | "stranded" | "failed";
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
/**
 * The per-browser memory of a dismissed offer: the candidate count it was dismissed at, keyed
 * by the ACCOUNT — a shared browser that signs out of one account and into another must not
 * carry the first account's dismissal over. The hook knows no account id, so the key is
 * derived from what the preview itself names: the account's mailbox ids, sorted.
 */
export const JUNK_SWEEP_DISMISSED_KEY = "ohmail.junkSweepDismissedAt";
export const dismissKeyOf = (pv: JunkSweepWire): string =>
  `${JUNK_SWEEP_DISMISSED_KEY}:${pv.mailboxes.map((m) => m.id).sort().join(",")}`;

function readDismissed(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
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
  const [bodies, setBodies] = useState<ReadonlyMap<string, SessionBodyHeld<JunkBodyWireAnswer>>>(
    () => new Map(),
  );
  /**
   * The session body cache's MECHANICS are the engine's (`createSessionBodyDoor` — the Content
   * Door's on-demand arm; this hook proved the pattern and now binds it instead of carrying its
   * own copy). `reopenFailed: true` is this door's policy: the automatic body-on-open fires per
   * selection, so a row that failed once is re-asked when the reader returns to it. The lazy
   * `useState` keeps ONE door per mounted window — the session — and `setBodies` is
   * identity-stable, so handing it in as `onChange` is safe.
   */
  const [bodyDoor] = useState(() =>
    createSessionBodyDoor<JunkBodyWireAnswer>({ onChange: setBodies, reopenFailed: true }),
  );
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
          // Appended, never re-sorted: the reader asked for OLDER, below what they have — and
          // never a row this session already rescued.
          const have = new Set(cur.map(junkKeyOf));
          return [...cur, ...page.items.filter((i) => !have.has(junkKeyOf(i)) && !dropped.current.has(junkKeyOf(i)))];
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
    (item: JunkItemWire): JunkBodyPhase => {
      const held = bodies.get(junkKeyOf(item));
      if (held === undefined) return { phase: "idle" };
      if (held.phase === "settled") return { phase: "ready", text: held.outcome.text };
      return held;
    },
    [bodies],
  );

  // One fetch per session per message, retry-replaces-a-hung-ask, superseded completions
  // dropped — the shared door's contract (see its header; the findings this hook's inline copy
  // carried are recorded there).
  const openBody = useCallback((item: JunkItemWire, opts: { retry?: boolean } = {}) => {
    bodyDoor.open(
      junkKeyOf(item),
      () => wire.body(item.mailboxId, item.uid, item.uidValidity),
      opts,
    );
  }, [bodyDoor, wire]);

  /* ── THE SEARCH-APPEND ─────────────────────────────────────────────────────────────────── */
  const [query, setQueryState] = useState("");
  const [searchPhase, setSearchPhase] = useState<JunkSearchControl["phase"]>("idle");
  const [hits, setHits] = useState<JunkItemWire[]>([]);
  const [searchBoxes, setSearchBoxes] = useState<JunkMailboxWire[]>([]);
  const [truncated, setTruncated] = useState(false);
  /** What is typed RIGHT NOW — a settling answer applies to the screen only if its term is this. */
  const queryRef = useRef("");
  /**
   * The server's answer PER SETTLED TERM, for this session: one ask per term, and a term typed
   * again shows the answer it already earned instead of an empty `local` that the debounce
   * refuses to fill (review round: the answer was discarded while the term stayed marked asked).
   */
  const answers = useRef(new Map<string, { items: JunkItemWire[]; mailboxes: JunkMailboxWire[]; truncated: boolean }>());
  /**
   * Terms with an ask IN FLIGHT. Without this, leaving a pending term and typing it again finds
   * no cached answer and kicks a SECOND provider search — and whichever finishes last would
   * write the cache (review round 2). One ask per term at a time; the cache is written by the
   * ask that ran, whatever generation is current on screen.
   */
  const pendingTerms = useRef(new Set<string>());
  /**
   * Rows this session RESCUED. A server answer that fetched a row before its move landed must
   * not put it back on screen — the filter runs at every place rows enter (search answers,
   * older pages).
   */
  const dropped = useRef(new Set<string>());
  const notDropped = useCallback((rows: JunkItemWire[]) => rows.filter((r) => !dropped.current.has(junkKeyOf(r))), []);

  const localKept = useMemo(
    () => (query.trim().length === 0 ? items : items.filter((i) => junkRowMatches(i, query))),
    [items, query],
  );

  const searchServer = useCallback((q?: string) => {
    const term = (q ?? query).trim();
    if (term.length === 0 || pendingTerms.current.has(term)) return;
    pendingTerms.current.add(term);
    setSearchPhase("searching");
    void wire.search(term).then(
      (page) => {
        pendingTerms.current.delete(term);
        const answer = { items: notDropped(page.items), mailboxes: page.mailboxes, truncated: page.truncated };
        answers.current.set(term, answer);
        // The answer reaches the SCREEN iff its term is what is typed right now — a person who
        // left the term and came back mid-flight sees it settle (review round 5: a generation
        // counter stranded exactly that return in `searching`), and an answer for an abandoned
        // term goes only to the cache it came for.
        if (queryRef.current.trim() !== term) return;
        setHits(answer.items);
        setSearchBoxes(answer.mailboxes);
        setTruncated(answer.truncated);
        setSearchPhase("done");
      },
      () => {
        pendingTerms.current.delete(term);
        if (queryRef.current.trim() !== term) return;
        setHits([]);
        setSearchBoxes([]);
        setTruncated(false);
        setSearchPhase("failed");
      },
    );
  }, [query, wire, notDropped]);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    queryRef.current = q;
    // A NEW query clears the screen's answer (hits for the old words under the new filter would
    // be the window claiming a match it never checked). A term the server ALREADY answered this
    // session shows that answer again (minus anything rescued since); a term whose ask is still
    // IN FLIGHT shows `searching` and is settled by that ask's own completion.
    const term = q.trim();
    const held = term.length > 0 ? answers.current.get(term) : undefined;
    if (held !== undefined) {
      setHits(notDropped(held.items));
      setSearchBoxes(held.mailboxes);
      setTruncated(held.truncated);
      setSearchPhase("done");
      return;
    }
    setHits([]);
    setSearchBoxes([]);
    setTruncated(false);
    setSearchPhase(term.length === 0 ? "idle" : pendingTerms.current.has(term) ? "searching" : "local");
  }, [notDropped]);

  useEffect(() => {
    // The automatic kick — ONLY while the segment is on screen, ONLY from `local` (a failed ask
    // waits for the human retry), ONLY when the local filter found nothing, ONLY once the typing
    // has rested, and ONLY for a term the server has not answered this session. Leaving the
    // segment cancels a pending kick (review round: a dial for a pane no longer visible).
    const term = query.trim();
    if (!active || term.length === 0 || phase !== "ready" || searchPhase !== "local") return;
    if (localKept.length > 0 || answers.current.has(term) || pendingTerms.current.has(term)) return;
    const timer = setTimeout(() => searchServer(term), JUNK_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [active, query, phase, searchPhase, localKept.length, searchServer]);

  const visible = useMemo(() => {
    if (query.trim().length === 0) return items;
    const have = new Set(localKept.map(junkKeyOf));
    return [...localKept, ...hits.filter((h) => !have.has(junkKeyOf(h)))];
  }, [items, query, localKept, hits]);

  /* ── THE RESCUE (both verbs) ───────────────────────────────────────────────────────────── */
  const dropRow = useCallback((key: string) => {
    dropped.current.add(key);
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
        // The PARTIAL outcome: the server committed the allow, then the move failed for another
        // reason (a timeout, a refusal). The row stays — it IS still in Junk — and the sentence
        // says the rules changed anyway, so the person is not left believing nothing happened.
        if (allow && wire.codeOf(err) === "junk_rescue_move_failed") {
          toast(t("junkRescueFailedAllowed"));
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
    const total = pv.mailboxes.reduce((n, m) => n + m.candidates, 0);
    if (total === 0) {
      // Genuinely empty — "done" only after a press THIS session, else nothing to say.
      setSweepPhase(pressed.current ? "done" : "none");
    } else if (pv.movable === 0) {
      // Candidates remain and none can move: every mailbox holding them has no Junk folder.
      // Not "empty", not an offer — the stranded rows are named and nothing is pressable.
      setSweepPhase("stranded");
    } else if (pv.pending) {
      setSweepPhase("pending");
    } else {
      // Offered only when the pile has GROWN past the size it was dismissed at — per account.
      setSweepPhase(pv.movable > readDismissed(dismissKeyOf(pv)) ? "offer" : "none");
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
    // Only while the segment is on screen: leaving pauses the beat, returning resumes it.
    if (!active || sweepPhase !== "pending") return;
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > JUNK_SWEEP_POLL_MAX) { clearInterval(timer); return; }
      void wire.sweepPreview().then(absorbPreview, () => { /* keep the last known state */ });
    }, JUNK_SWEEP_POLL_MS);
    return () => clearInterval(timer);
  }, [active, sweepPhase, wire, absorbPreview]);

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
      if (sweepPreview) window.localStorage.setItem(dismissKeyOf(sweepPreview), String(sweepPreview.movable));
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
