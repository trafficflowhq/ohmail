"use client";

/**
 * THE ACCOUNT'S LANGUAGE, OFFERED AT START: from the consent read the ground already makes, to the language controls the
 * host wraps around the frame (`host.device.language`). Moved from the old shell as it stood (`AppShell.tsx`).
 *
 * `adoptLocale`, never a setter that WRITES the account: that would PATCH it back on every boot. The host decides what
 * an adoption may move, since this read can be older than a press. Null: no preference, the device stands. A host
 * that hands no controls: nothing to adopt into.
 */
import { useEffect } from "react";
import { useConsent } from "@ohmail/app-logic/consent";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";

export function useLocaleAtBoot(): void {
  const localeControls = useFrame().host.device.language;
  const accountLocale = useConsent().locale;
  const adoptLocale = localeControls === NONE ? undefined : localeControls.adoptLocale;
  const activeLocale = localeControls === NONE ? undefined : localeControls.locale;
  useEffect(() => {
    if (!adoptLocale || accountLocale === null || accountLocale === activeLocale) return;
    void adoptLocale(accountLocale);
  }, [adoptLocale, accountLocale, activeLocale]);
}
