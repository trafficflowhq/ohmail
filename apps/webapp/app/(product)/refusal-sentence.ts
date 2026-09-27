"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { codeOf, messageOf, ownerRefusalCodes } from "../api-client";

/**
 * THE ONE RENDERER FOR A REFUSAL AN ACCOUNT PANE CAUGHT. The three owner refusals are raised by
 * this client, not the server, so their own text is an English literal; this says each in the
 * reader's language, keyed on `ownerRefusalCodes()`; a code added there without a sentence here
 * fails `owner-refusal-renders-once.test.tsx`. Everything else renders as `messageOf` always has.
 */
export const OWNER_REFUSAL_KEYS: Readonly<Record<string, string>> = {
  owner_absent: "refusedOwnerAbsent",
  owner_signed_out: "refusedOwnerSignedOut",
  owner_mismatch: "refusedOwnerMismatch",
};

export function useRefusalSentence(): (err: unknown) => string {
  const t = useTranslations("session");
  return useCallback((err: unknown): string => {
    const code = codeOf(err);
    const key = ownerRefusalCodes().includes(code) ? OWNER_REFUSAL_KEYS[code] : undefined;
    return key !== undefined ? t(key) : messageOf(err);
  }, [t]);
}
