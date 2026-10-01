/**
 * WHOSE BROWSER IS THIS — settled before an account-door page asks for anything. `/approve`,
 * `/authorize-desktop` and `/link-desktop` act as the signed-in account, so the account gate refuses
 * their requests until the client is bound, and a browser that never signed in holds no
 * `tf_owner`: its first request was refused before it was sent and the signed-out branch could not
 * be reached. Each page asks the one front-door classifier first, the way `/login` and the shell
 * do, and binds only after comparing the answer with the marker that answer may have written back.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiOwnerBinding, bindApiOwner } from "../../api-client";
import { readOwnerMarker } from "../../shell/owner-cookie";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "../../shell/confirm-schedule";
import { markSessionAlive, sessionIsDead } from "../../shell/session-truth";
import { resolveOwnerOutcome } from "../session-outcome";

/** `owner` is bound; `none` has no full session; `refused` binds nothing; `unchecked` got no answer. */
export type Settled =
  | { kind: "checking" }
  | { kind: "owner"; accountId: string }
  | { kind: "none" }
  | { kind: "refused"; refusal: ApiError }
  | { kind: "unchecked" };

/** One more settle after a later request finds the marker gone; a second is a sentence, never a loop. */
const RESETTLES = 1;

/**
 * May the classifier's account be bound here? The gate's own order: this tab's unconfirmed
 * sign-out, then the jar's reserved word, then a marker naming somebody else. Read AFTER the
 * answer, because `GET /auth/session` writes the marker back where the jar had none.
 */
export function bindRefusal(accountId: string): "owner_signed_out" | "owner_mismatch" | null {
  if (apiOwnerBinding().kind === "blocked") return "owner_signed_out";
  const marker = readOwnerMarker();
  if (marker.kind === "signed-out") return "owner_signed_out";
  if (marker.kind === "account" && marker.id !== accountId) return "owner_mismatch";
  return null;
}

/** The refusal the gate itself raises, so the page says it through the one renderer. */
function refused(code: "owner_signed_out" | "owner_mismatch"): Settled {
  return { kind: "refused", refusal: new ApiError(0, code, code) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Ask, on the login screen's ladder, and settle. `null` when aborted. A confirmed owner lifts a
 * death this tab latched earlier, as the shell's confirm does: the answer is the server's full
 * session, and a latch left standing refuses every read the page makes next.
 */
export async function settleOwner(signal: AbortSignal): Promise<Settled | null> {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await resolveOwnerOutcome({ signal }).catch(() => null);
    if (signal.aborted) return null;
    if (outcome === null) return { kind: "unchecked" };
    if (outcome.kind === "none") return { kind: "none" };
    if (outcome.kind === "owner") {
      const refusal = bindRefusal(outcome.accountId);
      if (refusal !== null) return refused(refusal);
      if (sessionIsDead()) markSessionAlive();
      bindApiOwner(outcome.accountId);
      return { kind: "owner", accountId: outcome.accountId };
    }
    if (attempt >= CONFIRM_ATTEMPTS) return { kind: "unchecked" };
    await sleep(nextConfirmDelay(attempt, outcome.retryAfterMs), signal);
    if (signal.aborted) return null;
  }
}

/** The account gate's refusal for a marker that went missing after the page settled. */
export function isOwnerAbsent(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0 && err.code === "owner_absent";
}

/**
 * The settle step as a page uses it: run on mount while `active`, and again on `resettle()` —
 * which a page calls when a later request meets `owner_absent`, so that refusal is never shown.
 */
export function useSettledOwner(active: boolean): { settled: Settled; resettle: () => void } {
  const [settled, setSettled] = useState<Settled>({ kind: "checking" });
  const [round, setRound] = useState(0);
  const resettles = useRef(0);
  useEffect(() => {
    if (!active) return;
    const ctl = new AbortController();
    void settleOwner(ctl.signal).then((s) => { if (s !== null && !ctl.signal.aborted) setSettled(s); });
    return () => ctl.abort();
  }, [active, round]);
  const resettle = useCallback((): void => {
    if (resettles.current >= RESETTLES) { setSettled({ kind: "unchecked" }); return; }
    resettles.current += 1;
    setSettled({ kind: "checking" });
    setRound((r) => r + 1);
  }, []);
  return { settled, resettle };
}
