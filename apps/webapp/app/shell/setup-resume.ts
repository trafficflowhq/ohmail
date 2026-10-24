"use client";

/**
 * SETUP RESUMES, ONCE PER TAB. An account that never connected a mailbox returned to an empty mail client and
 * nothing brought it back to setup. On a door with a setup page (`FirstRunHost.setupHref`, the web) the shell
 * sends it there once per tab, and only on answers: `GET /mailboxes` answered empty, the live consent read
 * answered with no finished setup, the default view with nothing in the URL, and no sign-in return on this
 * load. The setup page's "Do this later" lands on `/?setup=later`, which marks the tab instead.
 */

import { useEffect, useRef } from "react";
import type { FirstRunHost } from "./first-run-host";

/** The per-tab mark, written before the shell routes and by `/?setup=later`. */
const SETUP_OFFERED_KEY = "ohmail.setup.offered";

/** The default view: the Ohbox, with no open message and no other place named. */
const DEFAULT_HASHES = new Set(["", "#", "#/", "#/ohbox"]);

export interface SetupResumeFacts {
  /** `GET /mailboxes`; `null` until it has answered, and a failed read is not an answer. */
  mailboxes: readonly unknown[] | null;
  /** The LIVE consent read has answered (`ConsentState.onboardingKnown`). */
  consentAnswered: boolean;
  onboardingCompletedAt: string | null;
}

type SetupResumeVerdict = "wait" | "route" | "stay";

function setupResumeVerdict(
  f: SetupResumeFacts, at: { hash: string; search: string }, oauthPending: boolean,
): SetupResumeVerdict {
  if (f.mailboxes === null || !f.consentAnswered) return "wait";
  if (f.mailboxes.length > 0 || f.onboardingCompletedAt !== null) return "stay";
  // Any query is somebody else's: a pane name, a consent return, a payment return.
  if (oauthPending || !DEFAULT_HASHES.has(at.hash) || new URLSearchParams(at.search).toString() !== "") return "stay";
  return "route";
}

function tabStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Mark the tab; true only when it was unmarked and the mark was written. */
function claimSetupResume(storage: Storage | null): boolean {
  if (storage === null) return false;
  try {
    if (storage.getItem(SETUP_OFFERED_KEY) !== null) return false;
    storage.setItem(SETUP_OFFERED_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

/** `/?setup=later`: drop the parameter and mark the tab. True when it was there. */
function takeSetupLater(): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.get("setup") !== "later") return false;
  url.searchParams.delete("setup");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  try {
    tabStorage()?.setItem(SETUP_OFFERED_KEY, "1");
  } catch {
    // The ref in the hook still holds this load.
  }
  return true;
}

/** Decided once per mount, on the first answer; a door with no setup page never routes. */
export function useSetupResume(host: FirstRunHost | undefined, facts: SetupResumeFacts): void {
  const decided = useRef(false);
  const resume = host?.resume;
  const oauthPending = host?.oauthPending;
  const { mailboxes, consentAnswered, onboardingCompletedAt } = facts;
  useEffect(() => {
    if (!resume || decided.current) return;
    if (takeSetupLater()) {
      decided.current = true;
      return;
    }
    const verdict = setupResumeVerdict(
      { mailboxes, consentAnswered, onboardingCompletedAt }, window.location, oauthPending?.() ?? false,
    );
    if (verdict === "wait") return;
    decided.current = true;
    if (verdict === "route" && claimSetupResume(tabStorage())) resume();
  }, [resume, oauthPending, mailboxes, consentAnswered, onboardingCompletedAt]);
}
