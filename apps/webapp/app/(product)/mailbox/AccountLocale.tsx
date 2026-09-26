"use client";

/**
 * The account half of the language preference — the `AccountSection` seam, one context deeper. `LocaleShell` owns the
 * local half (`localStorage`, the cookie, the catalogue swap) and sits above `/login` and `/join`, so it cannot write
 * an account; this component sits INSIDE the shell, where a session is validated, and is the only place in the tree
 * that may import `app/api-client`.
 */

/**
 * A DECORATOR, not a second provider: it re-publishes `LocaleShell`'s controls with two methods replaced — `setLocale`
 * becomes "write the account, then apply" and `adoptLocale` refuses an answer older than that write — so there is
 * exactly one piece of state. Server first, not arbitrary:
 * `PATCH /consent/settings` happens BEFORE the catalogue swaps, and a failure rejects with the interface unchanged —
 * swap-then-undo would put the app in German for a second and leave the reader unable to say what their setting is;
 * the same rule every `consent-state.ts` setter keeps (resolve to what the database holds, never what the click
 * hoped).
 */

import { useMemo, useRef, type ReactNode } from "react";
import { LocaleContext, useAppLocale, type LocaleControls } from "../../shell/LocaleContext";
import { normalizeLocale, type AppLocale } from "../../shell/locale";
import { consent as consentApi } from "../../api-client";

export function AccountLocale({ children }: { children: ReactNode }) {
  const outer = useAppLocale();
  /* What this tab last wrote to the account, as its echo applied it. The shell adopts from its own
     consent read, which still holds the account's PREVIOUS answer until the next re-ask (and a boot
     read can land after the write): re-adopting that answer put German back on the first press of
     English, with the account already on English. So an adoption that disagrees with this tab's
     own write is older than the write and moves nothing; until a write, adoption is untouched. */
  const written = useRef<AppLocale | null>(null);

  const controls = useMemo<LocaleControls | null>(() => {
    if (outer === null) return null;
    return {
      ...outer,
      setLocale: async (next: AppLocale): Promise<void> => {
        /* The ECHO decides, not the argument. The route answers with the stored value, so a server
           that clamped or refused the write cannot leave this tab rendering a language the account
           does not hold. A `null` echo is the account asking for the default, which is English. */
        const stored = await consentApi.setLocale(next);
        /* NORMALISED, not trusted. The echo is a wire `string | null`: `null` is the account asking
           for the default (English), and anything the closed set does not recognise cannot come from
           a current server but must not be handed to a loader either. */
        const applied = normalizeLocale(stored) ?? "en";
        written.current = applied;
        await outer.adoptLocale(applied);
      },
      adoptLocale: async (next: AppLocale): Promise<void> => {
        if (written.current !== null && next !== written.current) return;
        await outer.adoptLocale(next);
      },
    };
  }, [outer]);

  /* No outer provider means no locale machinery at all — the demo's bare mount in a unit test.
     Rendering children unwrapped is the same honest degradation `useAppLocale` returning null is:
     no selector, English, nothing broken. */
  if (controls === null) return <>{children}</>;
  return <LocaleContext.Provider value={controls}>{children}</LocaleContext.Provider>;
}
