"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { ApiError, codeOf, messageOf } from "../api-client";

/**
 * THE ONE RENDERER FOR A REFUSAL AN ACCOUNT PANE CAUGHT. The three window-binding refusals and
 * `session_unchecked` are raised by this client with an English literal; this says each in the
 * reader's language. A code `ownerRefusalCodes()` adds without a sentence here fails
 * `owner-refusal-renders-once.test.tsx`. Everything else renders as `messageOf` always has.
 */
export const OWNER_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  owner_absent: "refusedOwnerAbsent",
  owner_signed_out: "refusedOwnerSignedOut",
  owner_mismatch: "refusedOwnerMismatch",
};

/**
 * `api-client`'s `SESSION_UNCHECKED` and `SESSION_ENDED_REFUSAL_CODE`, spelled here because a dozen
 * suites mock that module without them; `refusal-sentences-localized.test.tsx` pins them equal.
 */
export const CLIENT_RAISED = { unchecked: "session_unchecked", ended: "session_ended" } as const;

const CLIENT_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  ...OWNER_REFUSAL_KEYS,
  [CLIENT_RAISED.unchecked]: "refusedSessionUnchecked",
};

/**
 * Did the SERVER answer this refusal, in its own (English) words? The two client-raised refusals
 * with a 4xx/5xx status are not: `session_ended` is already said in the reader's language and
 * `session_unchecked` is said here. A surface maps a server answer to its own sentence.
 */
export function serverAnswered(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status >= 400
    && err.code !== CLIENT_RAISED.ended && err.code !== CLIENT_RAISED.unchecked;
}

export function useRefusalSentence(): (err: unknown) => string {
  const t = useTranslations("session");
  return useCallback((err: unknown): string => {
    const code = codeOf(err);
    return Object.hasOwn(CLIENT_REFUSAL_KEYS, code) ? t(CLIENT_REFUSAL_KEYS[code]!) : messageOf(err);
  }, [t]);
}
