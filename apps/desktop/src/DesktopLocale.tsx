/**
 * THE DESKTOP'S INTL PROVIDER — the same job `(product)/LocaleShell.tsx` does for the web, minus
 * everything that needs a server.
 *
 * There is no Next here, so there is no server render to resolve a cookie against and nothing to
 * negotiate: the window reads `localStorage` and paints. And there is no account — this build is
 * standalone by construction, its Cloud adapter is aliased out of the bundle, and
 * `apiConfigured()` is false — so `localStorage` is not a fallback for an account preference, it IS
 * the preference. The Settings row is the shared one; only what happens when it is pressed differs,
 * and that is the whole point of `LocaleContext`.
 *
 * ── BOTH CATALOGUES ARE STATIC IMPORTS, UNLIKE THE WEB'S ───────────────────────────────────────
 *
 * The web splits `de.json` into a lazy chunk so an English session never downloads it. Here that
 * would buy nothing: `vite.config.ts` sets `inlineDynamicImports`, so every chunk ends up in one
 * file inside the binary regardless, and a `import()` would only add a promise to the boot path. The
 * cost of carrying both is bounded by the same filter that keeps the marketing copy out —
 * `shellMessagesOnly()` rewrites BOTH files to the namespaces the shell reads, so what the binary
 * gains is the German half of the app's own vocabulary and nothing else.
 *
 * ── THE MERGE IS THE WEB'S RULE, RESTATED IN ONE LINE ──────────────────────────────────────────
 *
 * German fills over English, so a key `de.json` is missing renders the English sentence rather than
 * `use-intl`'s default fallback, which is the dotted KEY. It cannot import `i18n/catalog.ts` for
 * this — the publish DENYs `apps/webapp/i18n`, so that module does not exist in the mirror a
 * released binary is built from — so `fillFrom`'s rule lives in `app/shell/locale.ts`, which IS
 * published, and both hosts call it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

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
