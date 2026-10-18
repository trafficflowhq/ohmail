import { signOutTrouble, type SignOutTrouble } from "../../sign-out-trouble";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "../../shell/confirm-schedule";
import { readOwnerMarker } from "../../shell/owner-cookie";
import { SETTLE_DEADLINE_MS } from "../../session-refresh";

/**
 * FINISH A SIGN-OUT THE SERVER NEVER CONFIRMED (`tf_owner=signed_out_pending`), behind the form of the
 * page it reached (sign-in, sign-up, address confirmation: `pending-sign-out.tsx`): the sign-out door on
 * the confirm ladder, never the refresh door; the local half runs again.
 *
 * `confirmed`: the door answered (204, or its coded 401 for an ended family) and the wipe landed.
 * `stopped`: the door answered but the wipe was blocked or cannot be verified; asking the door again
 * changes nothing. `refused`: the ladder ran out with the server half unconfirmed (the wipe is retried
 * with it) and the marker stays for the next visit. Those two carry what to say (`said`, the account
 * pane's reading). `moved`: the jar stopped saying this sign-out is pending — a sign-in in another
 * tab, or the sign-out finished there — so nothing in it is this ladder's to end. `cancelled`: a
 * sign-in, registration or confirmation began here, or the page went (see {@link pendingSignOutSettled}).
 */
export type FinishOutcome = "confirmed" | "refused" | "stopped" | "moved" | "cancelled";

export interface Finish {
  outcome: FinishOutcome;
  said: SignOutTrouble | null;
}

/** The jar still says this browser's sign-out is unconfirmed: the one state the ladder may end. */
export const stillPending = (): boolean => readOwnerMarker().kind === "signed-out";

/** The attempt out now, door and wipe, or null. */
let attemptOut: Promise<unknown> | null = null;

export async function finishPendingSignOut({ isCancelled, attempts = CONFIRM_ATTEMPTS, mayEnd = stillPending }: {
  isCancelled: () => boolean;
  /** One for the sign-in's own ask before its ceremony; the ladder's length otherwise. */
  attempts?: number;
  /**
   * May this attempt still end the jar? Asked before every attempt, inside the cookie lock before the
   * door, and after a refusal before the wipe: a jar another tab signed in to is never presented.
   */
  mayEnd?: () => boolean;
}): Promise<Finish> {
  for (let n = 1; ; n += 1) {
    if (isCancelled()) return { outcome: "cancelled", said: null };
    // Loaded here, not with the page: the wipe and the engine behind it are not the form's to carry.
    const { signOut } = await import("../../sign-out");
    if (isCancelled()) return { outcome: "cancelled", said: null };
    if (!mayEnd()) return { outcome: "moved", said: null };
    const out = signOut(undefined, { mayProceed: mayEnd });
    attemptOut = out;
    let result;
    try {
      result = await out;
    } finally {
      if (attemptOut === out) attemptOut = null;
    }
    if (result === null) return { outcome: "moved", said: null };
    const said = signOutTrouble(result);
    if (said === null) return { outcome: "confirmed", said: null };
    if (result.serverRefused === null) return { outcome: "stopped", said };
    if (n >= attempts) return { outcome: "refused", said };
    await new Promise<void>((resolve) => { setTimeout(resolve, nextConfirmDelay(n, null)); });
  }
}

/**
 * Wait, bounded, for an attempt still out. A sign-in, a registration or a confirmation starts after
 * it, so neither the door's answer nor the wipe lands on the new session: the cookie lock alone misses
 * the wait before the door and a browser with no lock manager. A page that took over from another in
 * this tab waits for that page's attempt before its own ladder, so the door is asked once at a time.
 */
export async function pendingSignOutSettled(): Promise<void> {
  const out = attemptOut;
  if (out === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      out.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, SETTLE_DEADLINE_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
