"use client";

/**
 * A SIGN-IN IN ANOTHER TAB OF THIS BROWSER, heard by a tab that still keeps an approval's way back.
 * Every session mint stamps `SESSION_MINTED_KEY` (`session-refresh.ts`), which every other tab hears
 * as a `storage` event; where that write was refused, the sign-in still rewrote `tf_owner`, read
 * again when this tab is looked at. Either is a nudge to ASK, never an answer: it carries no
 * account and no request id, and only the classifier's full session calls `onFull`.
 */

import { SESSION_MINTED_KEY } from "../../session-refresh";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "../../shell/confirm-schedule";
import { readOwnerMarker } from "../../shell/owner-cookie";
import { resolveOwnerOutcome } from "../session-outcome";

/** What the jar names, as a value one reading can be compared with the next. */
function jarReading(): string {
  const m = readOwnerMarker();
  return m.kind === "account" ? `account:${m.id}` : m.kind;
}

/**
 * Each nudge asks again on the confirm ladder, a newer one replacing the ask an older one began.
 * The stop ends the listening AND aborts the ask in flight, whose answer then acts on nothing.
 */
export function whenSignedInElsewhere(onFull: () => void): () => void {
  let seen = jarReading();
  let asking: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async (ctl: AbortController, attempt: number): Promise<void> => {
    const outcome = await resolveOwnerOutcome({ signal: ctl.signal }).catch(() => null);
    if (ctl.signal.aborted || outcome === null) return;
    if (outcome.kind === "owner") { onFull(); return; }
    if (outcome.kind === "none" || attempt >= CONFIRM_ATTEMPTS) return;
    timer = setTimeout(() => void ask(ctl, attempt + 1), nextConfirmDelay(attempt, outcome.retryAfterMs));
  };
  const nudge = (): void => {
    seen = jarReading();
    asking?.abort();
    clearTimeout(timer);
    asking = new AbortController();
    void ask(asking, 1);
  };
  const onStorage = (e: StorageEvent): void => {
    if (e.key === SESSION_MINTED_KEY && e.newValue !== null) nudge();
  };
  const onBack = (): void => {
    if (document.visibilityState !== "hidden" && jarReading() !== seen) nudge();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onBack);
  window.addEventListener("pageshow", onBack);
  document.addEventListener("visibilitychange", onBack);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onBack);
    window.removeEventListener("pageshow", onBack);
    document.removeEventListener("visibilitychange", onBack);
    asking?.abort();
    clearTimeout(timer);
  };
}
