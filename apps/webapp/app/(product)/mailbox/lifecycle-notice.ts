"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLocale } from "next-intl";
import {
  ApiError, account, accessFeedFor, apiConfigured, onAccessFeed, putAwayCatchUp,
  type AccessFeed, type AccountAccess,
} from "../../api-client";
import { SELF_HOST_BUILD } from "../../hello";
import { durableSessionSet } from "@ohmail/app-logic/storage/durable";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { QUIET_RETURN_MS, RETURN_DEBOUNCE_MS, useAccessSchedule } from "@ohmail/app-logic/doors/wall-lift";
import { dismissKey, noticeOf, type Notice } from "./LifecycleBanner";
import { leaveForManagePage } from "./manage-navigation";

/**
 * Per SESSION, not for ever: a deadline a person put away this morning is worth saying again
 * tomorrow. `sessionStorage` throws in a private window and answers empty with site data blocked,
 * so every read and write is wrapped and an unreadable store means "not dismissed" — showing a
 * strip twice is a smaller failure than never showing it at all.
 */
function dismissed(key: string): boolean {
  try {
    return globalThis.sessionStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function remember(key: string): void {
  /* Through the session door, like every other per-viewer convenience: the door owns the refusal
     a private window or a full quota gives, and a store that will not keep this is not a reason
     to keep the strip up. */
  durableSessionSet(key, "1", "lifecycle.banner");
}

/** What the feed earns for this viewer: a notice, or `null`. Put-away keys are the dismissal's. */
function noticeFromFeed(entry: AccessFeed | null, hidden: ReadonlySet<string>, now: number): Notice | null {
  if (entry === null || !entry.answer.metered) return null;
  const next = noticeOf(entry.answer.lifecycle, entry.caughtUp ?? undefined, now);
  if (next === null) return null;
  const key = dismissKey(next, storageOwner());
  return hidden.has(key) || dismissed(key) ? null : next;
}

/** The schedule's read: `true` once the answer earns no deadline, which ends a hand-off poll. */
async function readForStrip(): Promise<boolean> {
  const a: AccountAccess = await account.access({ fresh: true });
  return !a.metered || noticeOf(a.lifecycle, undefined, Date.now()) === null;
}

/** What the account's strip has to say now, and its three answers. */
export interface LifecycleNotice {
  readonly notice: Notice | null;
  /** The manage page is being minted. */
  readonly busy: boolean;
  /** Why the last press did not leave: the wall's two sentences. */
  readonly mintRefusal: "failed" | "unverified" | null;
  readonly putAway: () => void;
  readonly toManage: () => Promise<void>;
}

/**
 * IT FOLLOWS THE ACCOUNT, not its own mount: it draws from the access feed (`api-client.ts`),
 * so any answer this tab receives moves it, and it asks once on every return to the tab (the
 * wall's schedule, no lift and no clock), polling after a hand-off. Bound: a tab that keeps focus
 * throughout a payment made on another device reads only on its next return.
 */
export function useLifecycleNotice(): LifecycleNotice {
  /** The account page opens in this screen's language, as the wall's does. */
  const lang = useLocale() === "de" ? "de" : "en";
  const active = !SELF_HOST_BUILD && apiConfigured();
  const entry = useSyncExternalStore(onAccessFeed, () => accessFeedFor(readOwner()), () => null);
  // Put away in THIS mount, so "Later" holds where the session store refuses the write.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [mintRefusal, setMintRefusal] = useState<"failed" | "unverified" | null>(null);
  const alive = useRef(true);
  const drawn = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);

  const notice = noticeFromFeed(entry, hidden, Date.now());
  useEffect(() => { drawn.current = notice !== null; });

  const { armPoll } = useAccessSchedule({
    read: active ? readForStrip : undefined,
    minute: null,
    owner: readOwner(),
    returnFloor: () => (drawn.current ? RETURN_DEBOUNCE_MS : QUIET_RETURN_MS),
    lastAsked: () => accessFeedFor(readOwner())?.at ?? 0,
  });

  useEffect(() => {
    if (!active) return;
    // The first paint joins the answer the shell's mount already asked for, or asks it.
    void account.access().catch(() => { /* no verdict, no sentence */ });
  }, [active]);

  const putAway = useCallback(() => {
    if (notice === null) return;
    const key = dismissKey(notice, storageOwner());
    remember(key);
    if (notice.kind === "caughtUp") putAwayCatchUp(readOwner());
    setHidden((was) => new Set([...was, key]));
  }, [notice]);

  const toManage = useCallback(async () => {
    setBusy(true);
    setMintRefusal(null);
    try {
      const link = await account.manageLink({ lang });
      const url = link?.url;
      if (typeof url === "string" && url.length > 0) {
        armPoll();
        leaveForManagePage(url);
        return;
      }
      // No page here (the mint's 404), or an answer with no address: the press went nowhere.
      if (alive.current) setMintRefusal("failed");
    } catch (err) {
      // A press is owed a sentence: an unconfirmed address is its own, anything else is "try again".
      const unverified = err instanceof ApiError && err.status === 403 && err.code === "email_unverified";
      if (alive.current) setMintRefusal(unverified ? "unverified" : "failed");
    }
    if (alive.current) setBusy(false);
  }, [armPoll, lang]);

  return { notice, busy, mintRefusal, putAway, toManage };
}
