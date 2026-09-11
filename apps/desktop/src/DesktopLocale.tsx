/**
 * THE DESKTOP'S INTL PROVIDER — `(product)/LocaleShell.tsx`'s job, minus everything that
 * needs a server. No Next, so no cookie to resolve and nothing to negotiate: the window reads
 * `localStorage` and paints — and with no account, `localStorage` IS the preference, not a
 * fallback. BOTH catalogues are static imports, unlike the web's lazy `de.json`:
 * `vite.config.ts` sets `inlineDynamicImports`, so every chunk lands in one file regardless
 * and an `import()` would only add a promise to the boot path; `shellMessagesOnly()` rewrites
 * both files to the namespaces the shell reads. The merge is the web's rule restated: German
 * fills over English, so a missing key renders the English sentence rather than the dotted
 */

/*
 * KEY — via `fillFrom` in `app/shell/locale.ts`, which IS published (the publish DENYs
 * `apps/webapp/i18n`, so `i18n/catalog.ts` does not exist in the mirror).
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { IntlProvider } from "use-intl";

import { LocaleContext, type LocaleControls } from "../../webapp/app/shell/LocaleContext.js";
import {
  DEFAULT_LOCALE,
  LOCALES,
  fillFrom,
  readStoredLocale,
  rememberLocale,
  setActiveCatalog,
  type AppLocale,
} from "../../webapp/app/shell/locale.js";
import en from "../../webapp/messages/en.json";
import de from "../../webapp/messages/de.json";

/**
 * The shape `IntlProvider` takes. Not `Record<string, unknown>`: the intl packages type a catalogue
 * as a recursive tree of strings, and the looser shape is what a JSON import gives — so the
 * narrowing happens once, here, rather than as a cast at the provider.
 */
type Messages = { [key: string]: string | Messages };

/** English as-is; anything else filled over it. Computed once per locale, at module scope. */
const CATALOGUES: Record<AppLocale, Messages> = {
  en: en as Messages,
  de: fillFrom(en as Messages, de as Messages) as Messages,
};

/**
 * The locale this window opens in — read BEFORE the first render rather than adopted in an effect,
 * so a German install never paints a frame of English. The same reason the theme stamp above the
 * mount in `main.tsx` is not an effect either.
 */
const INITIAL: AppLocale = readStoredLocale() ?? DEFAULT_LOCALE;

export function DesktopLocale({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<AppLocale>(INITIAL);
  const messages = CATALOGUES[locale];

  /* The non-hook register, set during render for `format.ts` — see `LocaleShell`'s note, which
     carries the whole argument for why this is not an effect. */
  const last = useRef<Messages | null>(null);
  if (last.current !== messages) {
    last.current = messages;
    setActiveCatalog(locale, messages);
  }

  /* `<html lang>` on the same pass, not in an effect — see `LocaleShell`'s note for the whole
     argument. It matters more here than there: the attribute selects the action bar's per-locale
     breakpoints (`shell/action-bar.css`), and this shell has no server render to make the first
     paint agree, so an effect meant a German launch painted German labels against the English
     rungs for a frame. Idempotent and guarded, exactly like the register above. */
  const lastLang = useRef<string | null>(null);
  if (lastLang.current !== locale) {
    lastLang.current = locale;
    document.documentElement.lang = locale;
  }

  const apply = useCallback(async (next: AppLocale): Promise<void> => {
    rememberLocale(next);
    setLocale(next);
  }, []);

  const controls = useMemo<LocaleControls>(
    () => ({
      locale,
      locales: LOCALES,
      /* SAME FUNCTION FOR BOTH VERBS, and that is the honest shape here rather than a shortcut:
         `setLocale` and `adoptLocale` differ only in whether they write an ACCOUNT, and this build
         has none. There is nothing for the second one to skip. */
      setLocale: apply,
      adoptLocale: apply,
      /* Never busy: both catalogues are already in the bundle, so a switch is a synchronous state
         change with nothing to wait for. */
      busy: false,
      /* THIS INSTALL, and on the hosted door too. The header above states why: the Cloud adapter is
         aliased out of this bundle and `apiConfigured()` is false, so `localStorage` is not a
         fallback for an account preference — it IS the preference. The shared row said "applies to
         this app everywhere you sign in" here, which promised a sync no code performs. */
      scope: "install" as const,
    }),
    [locale, apply],
  );

  return (
    <LocaleContext.Provider value={controls}>
      <IntlProvider
        locale={locale}
        messages={messages}
        timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
      >
        {children}
      </IntlProvider>
    </LocaleContext.Provider>
  );
}
