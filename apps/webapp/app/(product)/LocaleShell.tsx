"use client";

/**
 * The web host's intl provider, and the client half of the locale. The layout resolved the locale on the server
 * so the first paint is already right; what it cannot do is change, and the Settings selector must take effect
 * while somebody is looking at it. The switch swaps `messages` on the provider in place — the mirror stays
 * open, the engine keeps syncing, the open message holds; a reload would throw away an IndexedDB-backed shell
 * mid-sync for a display preference. The German catalogue arrives through `loadCatalog`'s dynamic import;
 * `busy` disables the selector for that one fetch. Persisted here: `localStorage` and the host-only cookie
 * ({@link rememberLocale}) — the LOCAL preference, all the pre-auth surface has. Not here: the ACCOUNT —
 * `AccountLocale.tsx` decorates these controls inside the shell, where a session is proven.
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { LocaleContext, type LocaleControls } from "../shell/LocaleContext";
import { LOCALES, rememberLocale, setActiveCatalog, type AppLocale } from "../shell/locale";
import { loadCatalog, type Messages } from "../../i18n/catalog";

export function LocaleShell({
  initialLocale,
  initialMessages,
  children,
}: {
  initialLocale: AppLocale;
  initialMessages: Messages;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ locale: AppLocale; messages: Messages }>({
    locale: initialLocale,
    messages: initialMessages,
  });
  const [busy, setBusy] = useState(false);

  /**
   * The non-hook register, set during render and not in an effect. `format.ts` reads it
   * synchronously while the tree below is rendering — `placeName(dest)` inside a reducer,
   * `resurfaceLabel(when)` inside a toast callback — so it must hold the same catalogue the
   * provider is about to render with, on the SAME pass; an effect runs after children commit, which
   * would paint a frame of English place names on every switch. Writing during render is a side
   * effect React tolerates only because it is IDEMPOTENT and derived from rendered state: a
   * StrictMode double invoke and a discarded concurrent render both leave it where the committed
   * render wants it. The `last` guard keeps it from rebuilding translators per re-render.
   */
  const last = useRef<Messages | null>(null);
  if (last.current !== state.messages) {
    last.current = state.messages;
    setActiveCatalog(state.locale, state.messages);
  }

  /**
   * `<html lang>` moves on the same pass as the catalogue. It is what a screen reader picks a voice
   * from and what the browser offers to translate — and it is now a LAYOUT INPUT: the action bar's
   * density ladder (`shell/action-bar.css`) carries one set of breakpoints per measured locale and
   * selects on `:root[lang]`, because German labels are 30-45% wider. In a passive effect this
   * attribute lands one commit AFTER the labels it describes — a switch into German painted German
   * words against the English rungs for a frame, and on the desktop (no server render) that was the
   * launch frame. Same discipline as the register above: written during render, idempotent, guarded
   * so it touches the DOM only when the value changes, and guarded on `document` (SSR has none).
   */
  const lastLang = useRef<string | null>(null);
  if (typeof document !== "undefined" && lastLang.current !== state.locale) {
    lastLang.current = state.locale;
    document.documentElement.lang = state.locale;
  }

  const apply = useCallback(async (next: AppLocale): Promise<void> => {
    const messages = await loadCatalog(next);
    rememberLocale(next);
    setState({ locale: next, messages });
  }, []);

  const adoptLocale = useCallback(
    async (next: AppLocale): Promise<void> => {
      if (next === state.locale) return;
      setBusy(true);
      try {
        await apply(next);
      } finally {
        setBusy(false);
      }
    },
    [apply, state.locale],
  );

  const controls = useMemo<LocaleControls>(
    () => ({
      locale: state.locale,
      locales: LOCALES,
      /* The LOCAL setter. `AccountLocale` replaces this one inside the mail client with a version
         that writes the account first; on `/login` and `/join` there is no account and this is the
         whole of the persistence. */
      setLocale: adoptLocale,
      adoptLocale,
      busy,
      /* The browser client's language is the ACCOUNT's: `AccountLocale` wraps this provider inside
         the mail client and writes `PATCH /consent/settings` before the catalogue swaps. On
         `/login` and `/join` there is no account yet and this setter is the whole persistence, but
         the row that states the reach is only ever drawn inside Settings, behind that wrapper. */
      scope: "account" as const,
    }),
    [state.locale, adoptLocale, busy],
  );

  return (
    <LocaleContext.Provider value={controls}>
      <NextIntlClientProvider locale={state.locale} messages={state.messages}>
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
