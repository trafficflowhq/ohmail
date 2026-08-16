"use client";

/**
 * THE ACCOUNT HALF OF THE LANGUAGE PREFERENCE — the same seam as `AccountSection` and
 * `MailboxSection`, one context deeper instead of one node.
 *
 * `LocaleShell` (the `(product)` layout) owns the local half: `localStorage`, the host-only cookie,
 * and the catalogue swap. It sits ABOVE `/login` and `/join` as well as the mail client, so it
 * cannot write an account — there may not be one yet. This component sits INSIDE the shell, where
 * `middleware.ts` has already validated a session, and it is the only place in the tree that may
 * import `app/api-client` at all (the publish DENYs that module, and the desktop resolves it to a
 * stub whose calls throw).
 *
 * It is a DECORATOR rather than a second provider: it takes the controls `LocaleShell` published and
 * re-publishes them with one method replaced. `setLocale` becomes "write the account, then apply";
 * everything else — `locale`, `locales`, `adoptLocale`, `busy` — passes through untouched, so there
 * is exactly one piece of state and no way for the row and the catalogue to disagree.
 *
 * ── THE ORDER IS SERVER FIRST, AND IT IS NOT ARBITRARY ─────────────────────────────────────────
 *
 * `PATCH /consent/settings` happens BEFORE the catalogue swaps, and a failure rejects without the
 * interface having changed. The alternative — swap, then write, then undo on failure — puts the app
 * in German for a second and takes it away again, and leaves the reader unable to say what their
 * setting actually is. This is the same rule every setter in `consent-state.ts` keeps: resolve to
 * what the DATABASE holds, never to what the click hoped for.
 *
 * The Settings row reports the rejection; see `SettingsView`'s language row.
 */

import { useMemo, type ReactNode } from "react";
import { LocaleContext, useAppLocale, type LocaleControls } from "../../shell/LocaleContext";
import { normalizeLocale, type AppLocale } from "../../shell/locale";
import { consent as consentApi } from "../../api-client";

export function AccountLocale({ children }: { children: ReactNode }) {
  const outer = useAppLocale();

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
        await outer.adoptLocale(normalizeLocale(stored) ?? "en");
      },
    };
  }, [outer]);

  /* No outer provider means no locale machinery at all — the demo's bare mount in a unit test.
     Rendering children unwrapped is the same honest degradation `useAppLocale` returning null is:
     no selector, English, nothing broken. */
  if (controls === null) return <>{children}</>;
  return <LocaleContext.Provider value={controls}>{children}</LocaleContext.Provider>;
}
