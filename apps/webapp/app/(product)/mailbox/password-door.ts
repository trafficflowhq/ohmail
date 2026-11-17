"use client";

import { useMemo } from "react";
import type { Answer, PasswordDoor, PasswordWord } from "@ohmail/app/account";
import { ApiError, auth } from "../../api-client";
import { serverAnswered, useRefusalSentence } from "../refusal-sentence";
import { gatedRefusal } from "./gated-refusal";

type Refused = Exclude<Answer<never, PasswordWord>, { ok: true }>;

/** Whole minutes left on a lockout, from the refusal's `retryAfter` seconds; fifteen where the server names none. */
function minutesOf(err: ApiError): number {
  const retryAfter = (err.details as { retryAfter?: unknown } | undefined)?.retryAfter;
  const seconds = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : 15 * 60;
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * A REFUSED CHANGE, AS ITS WORD, read in this order. Two answers come BEFORE the gate's, which takes every 401 for
 * a dead session: 401 `credential_refused` is a verdict on what was typed, said in place; 423 is the lockout the
 * change shares with sign-in, with its minutes. Then the gate: 403 `step_up_required` asks the factor (the group's
 * machine says a second one, right after a verified factor, as the way back in); a dead session or an unfinished
 * enrolment is the way back in. Then a request no server answered, said by the one renderer; the throttle; a change
 * another session made first; and any other refusal.
 */
export function passwordRefusal(err: unknown, say: (err: unknown) => string): Refused {
  if (err instanceof ApiError && err.status === 401 && err.code === "credential_refused") {
    return { ok: false, word: "wrong_current" };
  }
  if (err instanceof ApiError && err.status === 423) {
    return { ok: false, word: "locked", minutes: minutesOf(err) };
  }
  const why = gatedRefusal(err, false);
  if (why === "factor") return { ok: false, word: "factor" };
  if (why === "sign-in") return { ok: false, word: "sign_in" };
  if (!serverAnswered(err)) return { ok: false, word: "said", said: say(err) };
  if (err.code === "sign_in_slowed") return { ok: false, word: "slowed" };
  if (err.status === 409) return { ok: false, word: "conflict" };
  return { ok: false, word: "refused" };
}

/**
 * THE WEB'S PASSWORD DOOR: one request, `POST /auth/password {currentPassword, newPassword}`, tried as it is. The
 * two typed values are this call's arguments and nothing else's: they are in no log line, no sentence and no stored
 * key, and a refusal answers a word.
 */
export function passwordDoor(say: (err: unknown) => string): PasswordDoor {
  return {
    async change(current, next) {
      try {
        const out = await auth.changePassword({ currentPassword: current, newPassword: next });
        return { ok: true, value: { ended: out.revoked } };
      } catch (err) {
        return passwordRefusal(err, say);
      }
    },
  };
}

/** The web's password door, its client-raised refusals said in the reader's language. */
export function usePasswordDoor(): PasswordDoor {
  const say = useRefusalSentence();
  return useMemo(() => passwordDoor(say), [say]);
}
