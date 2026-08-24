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
 * ── THE RESCUE ────────────────────────────────────────────────────────────────────────────
 *
 * "Not junk" is ONE server-side move out of Junk (the un-training gesture); the message then
 * re-enters through the NORMAL pipeline — a first-time sender waits in the Screener, an allowed
 * one lands in the Ohbox. The row leaves this list on success. A 410 — the provider removed the
 * message first — also removes the row (it IS gone from Junk) but says what happened; any other
 * failure keeps the row and says so, because a row that silently vanished on a failed rescue
 * would be this window inventing the provider's state.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { ToastFn } from "@ohmail/ui";
import {
  ApiError, apiConfigured, screener as screenerApi,
  type JunkItemWire, type JunkMailboxWire,
} from "../api-client";

/** One row's stable key — a UID is only unique per mailbox. */
export const junkKeyOf = (i: { mailboxId: string; uid: number }): string => `${i.mailboxId}:${i.uid}`;

export type JunkBodyPhase =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "ready"; text: string }
  | { phase: "failed" };

export interface JunkWindowControl {
  /** The list read's own state — `failed` is rendered as failed, never as empty. */
  phase: "loading" | "ready" | "failed";
  items: JunkItemWire[];
  mailboxes: JunkMailboxWire[];
  nextCursor: string | null;
  olderLoading: boolean;
  /** Re-ask after a failure (a human press), or refresh the window. */
  reload: () => void;
  loadOlder: () => void;
  /** The session body cache: opening twice costs one fetch; closing the app forgets it. */
  bodyFor: (item: JunkItemWire) => JunkBodyPhase;
  openBody: (item: JunkItemWire) => void;
  /** "Not junk" — the rescue. The row leaves the list when the server confirmed the move. */
  rescue: (item: JunkItemWire) => void;
  rescuing: (item: JunkItemWire) => boolean;
}

/**
 * The window's state machine. `active` is "the Junk segment is on screen AND the feature is on":
 * the first page loads lazily on entry and stays for the session; nothing is fetched while the
 * flag is off or the view is elsewhere.
 */
export function useJunkWindow(active: boolean, toast: ToastFn): JunkWindowControl {
  const t = useTranslations("screener");
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<JunkItemWire[]>([]);
  const [boxes, setBoxes] = useState<JunkMailboxWire[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [bodies, setBodies] = useState<Map<string, JunkBodyPhase>>(() => new Map());
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  /** Has THIS session read page one yet? Lazily, once, on segment entry. */
  const asked = useRef(false);
  /** A stale page must not land over a newer reload's answer. */
  const generation = useRef(0);

  const fetchFirst = useCallback(() => {
    if (!apiConfigured()) return;
    const gen = ++generation.current;
    setPhase("loading");
    void screenerApi.junkList().then(
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
  }, []);

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
    void screenerApi.junkList({ cursor: nextCursor }).then(
      (page) => {
        setOlderLoading(false);
        // Appended, never re-sorted: the reader asked for OLDER, below what they have.
        setItems((cur) => {
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
  }, [nextCursor, olderLoading, toast, t]);

  const bodyFor = useCallback(
    (item: JunkItemWire): JunkBodyPhase => bodies.get(junkKeyOf(item)) ?? { phase: "idle" },
    [bodies],
  );

  const openBody = useCallback((item: JunkItemWire) => {
    const key = junkKeyOf(item);
    setBodies((cur) => {
      const held = cur.get(key);
      // One fetch per session per message — `ready` and in-flight `loading` are both answers.
      if (held && held.phase !== "failed") return cur;
      void screenerApi.junkBody(item.mailboxId, item.uid).then(
        (b) => setBodies((m) => new Map(m).set(key, { phase: "ready", text: b.text })),
        () => setBodies((m) => new Map(m).set(key, { phase: "failed" })),
      );
      return new Map(cur).set(key, { phase: "loading" });
    });
  }, []);

  const rescue = useCallback((item: JunkItemWire) => {
    const key = junkKeyOf(item);
    setBusy((cur) => new Set(cur).add(key));
    void screenerApi.junkRescue(item.mailboxId, item.uid, item.uidValidity).then(
      () => {
        setBusy((cur) => { const n = new Set(cur); n.delete(key); return n; });
        // CONFIRMED first, removed second — the row leaves only for a move that happened.
        setItems((cur) => cur.filter((i) => junkKeyOf(i) !== key));
        toast(t("junkRescued"));
      },
      (err: unknown) => {
        setBusy((cur) => { const n = new Set(cur); n.delete(key); return n; });
        if (err instanceof ApiError && err.status === 410) {
          // The provider (or another client) removed it first. It IS out of Junk — the row
          // goes — but the sentence says what happened rather than claiming our move did it.
          setItems((cur) => cur.filter((i) => junkKeyOf(i) !== key));
          toast(t("junkRescueGone"));
          return;
        }
        toast(t("junkRescueFailed"));
      },
    );
  }, [toast, t]);

  const rescuing = useCallback((item: JunkItemWire) => busy.has(junkKeyOf(item)), [busy]);

  return {
    phase, items, mailboxes: boxes, nextCursor, olderLoading,
    reload, loadOlder, bodyFor, openBody, rescue, rescuing,
  };
}
