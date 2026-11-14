"use client";

import { useEffect, useMemo, useRef } from "react";
import type { AccountDoor } from "@ohmail/app/account";
import { ApiError, auth } from "../../api-client";
// The one correct way out: it revokes at the server and wipes this browser's copy. Every logout goes through it.
import { readSessionFamily } from "../../signed-out-signal";
import { signOut, signOutStayReason } from "../../sign-out";
import { useRefusalSentence } from "../refusal-sentence";

/**
 * THE WEB'S ACCOUNT DOOR. Who is signed in is the session's own answer (`GET /auth/session`): a full session
 * names the address; an enrolment still open, or a 401 or 403, is nobody signed in; anything else is a read that
 * failed, said with no remedy (signing in again is not the remedy for a server that could not answer).
 *
 * Sign-out is not guarded by a factor. It ends the account this pane named. The landing page takes
 * over once the mailbox is retired, including when the browser still owes cleanup or a server retry.
 *
 * The erase is the delete page's: this door only leaves for it. The way to the sign-in page is the shell's own way
 * back to a live session, handed in: this file names no second one.
 */
export function accountDoor(say: (err: unknown) => string, toSignIn: () => void): AccountDoor {
  /** The account the last read named. Kept here for the one press that needs it; never handed to a pane. */
  let named: { account: string; family: string | undefined } | undefined;
  return {
    async who() {
      named = undefined;
      const heldFamily = readSessionFamily();
      try {
        const { user, scope, familyId } = await auth.session();
        if (scope === "full" && user?.accountId) {
          named = { account: user.accountId, family: familyId ?? heldFamily ?? undefined };
          return { ok: true, value: { address: user.email } };
        }
        return { ok: false, word: "signed_out" };
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return { ok: false, word: "signed_out" };
        }
        return { ok: false, word: "said", said: say(err) };
      }
    },
    async signOut() {
      if (named === undefined) return "unverified";
      const outcome = await signOut(named.account, { expectedFamily: named.family });
      const stay = signOutStayReason(outcome);
      if (stay !== null) return stay;
      window.location.assign("/");
      return "left";
    },
    toErase: () => {
      window.location.assign("/account/delete");
    },
    toSignIn,
  };
}

/**
 * The web's Account door, its client-raised refusals said in the reader's language. `toSignIn` is the host's way
 * back to a live session (`host.session.recover`, asked to sign in), handed in by the shell's registration.
 */
export function useAccountDoor(toSignIn: () => void): AccountDoor {
  const say = useRefusalSentence();
  // The door stays one door whatever function the shell hands in from draw to draw: a new door would ask again
  // who is signed in.
  const way = useRef(toSignIn);
  useEffect(() => {
    way.current = toSignIn;
  });
  return useMemo(() => accountDoor(say, () => way.current()), [say]);
}
