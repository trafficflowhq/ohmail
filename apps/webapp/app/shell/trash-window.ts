"use client";

/**
 * THE LIVE TRASH WINDOW'S CLIENT STATE — a read-only view of the provider's own \Trash, beside
 * the mirrored deletes the Trash view already lists.
 *
 * Two populations, two sources. `useTrashPage` reads the MIRROR: what ohmail deleted, ordered by
 * the instant of the press, each row carrying where a restore would put it. This hook reads the
 * FOLDER — mail deleted in Apple Mail, in Gmail's web client or on a phone, which the sync never
 * sees because that folder has no cursor. Those rows never enter `messages`, any client mirror or
 * any store table; they live here for as long as the view is mounted, and closing it forgets them.
 *
 * ── NO VERB, BY CONSTRUCTION ────────────────────────────────────────────────────────────────
 *
 * The junk window has a rescue because a spam verdict is the reader's own to reverse. This has
 * nothing. ohmail's restore aims at a mirror row's recorded origin folder; a message the provider
 * put in Trash has no origin recorded anywhere, so "put it back" would be ohmail choosing a folder
 * for somebody else's mail. So this control exposes NO mutation — not an omitted prop, no verb in
 * the type at all — and {@link trashReadVerbs} names the empty action set the reading column
 * renders for a live row.
 *
 * ── THE STATES ARE NAMED AND NONE STANDS IN FOR ANOTHER ─────────────────────────────────────
 *
 * A window that could not read SAYS so: `failed` renders the failed sentence and a human retry,
 * never an empty list — "your mail server's Trash is empty" is an answer, and a dead dial has no
 * business claiming it. Per-mailbox degrades ride the answer itself (`no_trash_folder`,
 * `unreachable`), so a mailbox with no native \Trash gets the stated absence and a mailbox the
 * server could not finish reading inside its budget gets the stated read limit.
 * {@link trashLiveState} is the one place those are decided; the view renders its verdict.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createSessionBodyDoor, type SessionBodyHeld } from "@ohmail/client-engine";
import {
  apiConfigured, trashWindow as trashWindowApi,
  type TrashWindowItemWire, type TrashWindowMailboxWire, type TrashWindowPageWire,
} from "../api-client";

/**
 * One live row's stable key. EPOCH-SCOPED: a UID names a message only within one UIDVALIDITY,
 * and Trash is the folder providers purge — so a key without the epoch would alias a recreated
 * folder's reused numbers onto the old rows' selection and session body cache.
 */
export const trashLiveKeyOf = (
  i: { mailboxId: string; uidValidity: string; uid: number },
): string => `${i.mailboxId}:${i.uidValidity}:${i.uid}`;

/**
 * THE TWO READS THIS WINDOW MAKES, behind one seam a host replaces with its own transport —
 * the junk window's `JunkWire` rule, and what makes the section exist on the desktop at all: that build
 * aliases the Cloud client to a refusing stub, so a hook reaching for it directly could only ever
 * report "no server" (which is precisely what it did).
 *
 * GET-ONLY, AND THE ABSENCE IS THE CONTRACT: there are two reads here and there is no verb, on
 * this seam or on any wire satisfying it. A message the provider filed in Trash has no origin
 * recorded anywhere, so "put it back" would be ohmail choosing a folder for somebody else's mail.
 */
export interface TrashWire {
  list(opts?: { cursor?: string }): Promise<TrashWindowPageWire>;
  body(mailboxId: string, uid: number, uidValidity: string): Promise<{ subject: string; text: string }>;
}

/** The browser's wire: the Cloud client, verbatim. */
const cloudWire: TrashWire = {
  list: (opts) => trashWindowApi.list(opts),
  body: (m, u, v) => trashWindowApi.body(m, u, v),
};

/** What one settled live-body ask holds — the route's own answer. */
type TrashBodyWireAnswer = { subject: string; text: string };

export type TrashLiveBodyPhase =
  | { phase: "idle" }
  /** `attempt` numbers each ask for one row, so the reading half can remount per try. */
  | { phase: "loading"; attempt: number }
  | { phase: "ready"; text: string }
  | { phase: "failed" };

/**
 * WHICH VERBS THE TRASH READING COLUMN OFFERS, decided by which population the open row belongs
 * to. The `none` arm is a named state and not a missing prop: `MessagePane` with no `trash` prop
 * renders the FULL eleven-group bar, so omission here would arm every filing verb over a message
 * that is not in the mirror. Both arms are reachable and each has a twin.
 */
export type TrashReadVerbs =
  | { verbs: "restore_and_read" }
  | { verbs: "none"; why: "live_row_has_no_destination" };

export function trashReadVerbs(row: { live: boolean }): TrashReadVerbs {
  return row.live
    ? { verbs: "none", why: "live_row_has_no_destination" }
    : { verbs: "restore_and_read" };
}

export interface TrashWindowControl {
  /**
   * IS THERE ANYTHING TO ASK — `apiConfigured()` for the browser's wire, `true` whenever a host
   * handed one in ({@link TrashWire}), because a host wire IS the server. The shell withholds the
   * control from the view when it is false and the hook fetches nothing: a build whose api client
   * is a refusing stub would otherwise hold a permanent loading state over the section.
   */
  supported: boolean;
  /** The list read's own state. `failed` renders as failed, never as an empty folder. */
  phase: "loading" | "ready" | "failed";
  /**
   * The live rows, newest first — ohmail's OWN deletes removed. The server attributes each row
   * (`origin`), and an `"ohmail"` row is already in the mirrored section above with its deletion
   * time and its restore; keeping it here would show one message twice in one view.
   */
  items: TrashWindowItemWire[];
  mailboxes: TrashWindowMailboxWire[];
  nextCursor: string | null;
  olderLoading: boolean;
  /** Re-ask after a failure, or refresh the window. A human press — this hook never loops. */
  reload: () => void;
  loadOlder: () => void;
  /** The session body cache: opening twice costs one read; leaving the view forgets it. */
  bodyFor: (item: TrashWindowItemWire) => TrashLiveBodyPhase;
  /** Read one row's body on open. `retry: true` replaces whatever the cache holds. */
  openBody: (item: TrashWindowItemWire, opts?: { retry?: boolean }) => void;
}

/**
 * WHAT THE SECTION SAYS, decided in one place. The order is the honesty: a stronger state is
 * never reported as a weaker one.
 *
 *  · `read_limited` OUTRANKS `empty` — zero rows beside a mailbox the server could not finish
 *    reading inside its budget is a read limit, not an empty folder;
 *  · `unavailable` is "there is no folder to read" — no mailbox this window serves, or every one
 *    of them without a native \Trash;
 *  · `empty` needs a DRAINED walk as well as zero rows: ohmail's own deletes are dropped from
 *    this population, so a page can arrive holding nothing for this section while older pages
 *    still hold rows. That case is `more_to_read`, which claims nothing and offers the press.
 */
export type TrashLiveState =
  | { state: "loading" }
  | { state: "failed" }
  | { state: "rows" }
  | { state: "unavailable" }
  | { state: "read_limited" }
  | { state: "more_to_read" }
  | { state: "empty" };

export function trashLiveState(c: {
  phase: TrashWindowControl["phase"];
  items: readonly unknown[];
  mailboxes: readonly TrashWindowMailboxWire[];
  nextCursor: string | null;
}): TrashLiveState {
  if (c.phase === "loading") return { state: "loading" };
  if (c.phase === "failed") return { state: "failed" };
  if (c.items.length > 0) return { state: "rows" };
  if (c.mailboxes.some((m) => m.window === "unreachable")) return { state: "read_limited" };
  if (c.mailboxes.length === 0 || c.mailboxes.every((m) => m.window === "no_trash_folder")) {
    return { state: "unavailable" };
  }
  if (c.nextCursor !== null) return { state: "more_to_read" };
  return { state: "empty" };
}

/** The live population only — the mirrored section owns ohmail's own deletes. See `items`. */
const liveOnly = (rows: TrashWindowItemWire[]): TrashWindowItemWire[] =>
  rows.filter((r) => r.origin !== "ohmail");

/**
 * The window's state machine. `active` is "the Trash view is on screen AND the feature is on":
 * the first page is read once on arrival and the whole state is dropped on leaving, because
 * these rows are off-mirror and stale the moment somebody walks away.
 */
export function useTrashWindow(active: boolean, hostWire?: TrashWire): TrashWindowControl {
  const wire = hostWire ?? cloudWire;
  const supported = hostWire !== undefined || apiConfigured();
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<TrashWindowItemWire[]>([]);
  const [boxes, setBoxes] = useState<TrashWindowMailboxWire[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [bodies, setBodies] = useState<ReadonlyMap<string, SessionBodyHeld<TrashBodyWireAnswer>>>(
    () => new Map(),
  );
  /**
   * The session body cache's mechanics are the engine's (`createSessionBodyDoor` — the Content
   * Door's on-demand arm). `reopenFailed: true` is this door's policy for the junk window's
   * reason: the body-on-open fires per selection, so a row that failed once is re-asked when the
   * reader returns to it. `setBodies` is identity-stable, so handing it in is safe.
   */
  const [bodyDoor] = useState(() =>
    createSessionBodyDoor<TrashBodyWireAnswer>({ onChange: setBodies, reopenFailed: true }),
  );
  /** Has THIS visit read page one yet? Once, on arrival. */
  const asked = useRef(false);
  /** A stale page must not land over a newer reload's answer. */
  const generation = useRef(0);

  const fetchFirst = useCallback(() => {
    if (!supported) {
      // No server behind this build: the honest resting state, never an eternal spinner.
      setPhase("failed");
      return;
    }
    const gen = ++generation.current;
    setPhase("loading");
    void wire.list().then(
      (page) => {
        if (generation.current !== gen) return;
        setItems(liveOnly(page.items));
        setBoxes(page.mailboxes);
        setNextCursor(page.nextCursor);
        setPhase("ready");
      },
      () => {
        if (generation.current !== gen) return;
        // FAILED, not empty. The retry is the reader's press, not a loop's.
        setPhase("failed");
      },
    );
  }, [supported, wire]);

  useEffect(() => {
    if (!active) {
      // Leaving drops the window: these rows are the folder's state a moment ago, and rendering
      // them again on the next visit would show yesterday's Trash while a fresh page loads.
      asked.current = false;
      generation.current += 1;
      setItems([]);
      setBoxes([]);
      setNextCursor(null);
      setOlderLoading(false);
      setPhase("loading");
      return;
    }
    if (asked.current) return;
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
        /* AN EPOCH RESET IS A RESTART, NOT AN APPEND. The server states which mailbox's cursor it
           discarded (`reset`) because a purged-and-recreated folder that is now empty contributes
           no row to infer it from. That mailbox's rows are its new TOP page; appending them under
           the old ones would file the folder's newest mail at the bottom, and splicing one mailbox
           would half-consume the others' pages. So the window starts over. */
        if (page.mailboxes.some((m) => m.reset === true)) {
          fetchFirst();
          return;
        }
        setItems((cur) => {
          const have = new Set(cur.map(trashLiveKeyOf));
          return [...cur, ...liveOnly(page.items).filter((i) => !have.has(trashLiveKeyOf(i)))];
        });
        setBoxes(page.mailboxes);
        setNextCursor(page.nextCursor);
      },
      () => {
        // The page that failed is the one not shown. The window keeps what it has and the press
        // stays available; nothing re-asks on its own.
        setOlderLoading(false);
      },
    );
  }, [nextCursor, olderLoading, fetchFirst, wire]);

  const bodyFor = useCallback(
    (item: TrashWindowItemWire): TrashLiveBodyPhase => {
      const held = bodies.get(trashLiveKeyOf(item));
      if (held === undefined) return { phase: "idle" };
      if (held.phase === "settled") return { phase: "ready", text: held.outcome.text };
      return held;
    },
    [bodies],
  );

  const openBody = useCallback((item: TrashWindowItemWire, opts: { retry?: boolean } = {}) => {
    bodyDoor.open(
      trashLiveKeyOf(item),
      () => wire.body(item.mailboxId, item.uid, item.uidValidity),
      opts,
    );
  }, [bodyDoor, wire]);

  return {
    supported,
    phase,
    items,
    mailboxes: boxes,
    nextCursor,
    olderLoading,
    reload,
    loadOlder,
    bodyFor,
    openBody,
  };
}
