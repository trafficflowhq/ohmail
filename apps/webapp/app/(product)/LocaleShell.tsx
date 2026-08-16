"use client";

/**
 * THE WEB HOST'S INTL PROVIDER, and the client half of the locale.
 *
 * `(product)/layout.tsx` resolved the locale from the cookie on the server and loaded the catalogue
 * for it, so the FIRST PAINT is already in the right language — no flash, nothing to correct after
 * hydration. What it cannot do is change: a server component re-renders only on a navigation, and
 * the Settings selector has to take effect while somebody is looking at it. That is this file.
 *
 * ── NO RELOAD, AND THE COST OF THAT IS ONE LAZY CHUNK ──────────────────────────────────────────
 *
 * The switch swaps `messages` on the provider in place. Every `useTranslations` below re-renders
 * with the new catalogue and the mail client keeps its state: the mirror stays open, the engine
 * keeps syncing, the open message stays open, the scroll position holds. A `location.reload()` — or
 * a `router.refresh()`, which would have worked too — would have thrown away an IndexedDB-backed
 * shell mid-sync to change a display preference, which is a bad trade on a slow connection and a
 * worse one on a mailbox that is still importing.
 *
 * The German catalogue arrives through `loadCatalog`'s dynamic import, so an English session never
 * downloads it and the switch pays one chunk fetch once. `busy` is true for the length of that
 * fetch, which is why the selector disables itself rather than queueing a second switch.
 *
 * ── WHAT IS PERSISTED HERE, AND WHAT IS NOT ────────────────────────────────────────────────────
 *
 * Here: `localStorage` and the host-only cookie ({@link rememberLocale}) — the LOCAL preference,
 * which is what the pre-auth surface has. `/login` and `/join` render inside this layout and have
 * no account yet, so a reader who switches to German on the sign-in screen stays in German through
 * the sign-in and into the app.
 *
 * Not here: the ACCOUNT. This file is above the mail client and above the credential screens
 * alike, and it may not assume a session exists. `(product)/mailbox/AccountLocale.tsx` decorates
 * these controls with the account write, inside the shell where a session is proven.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
   * THE NON-HOOK REGISTER, SET DURING RENDER AND NOT IN AN EFFECT.
   *
   * `format.ts` reads it synchronously while the tree below is rendering — `placeName(dest)` inside
   * a reducer, `resurfaceLabel(when)` inside a toast callback — so it has to hold the same
   * catalogue the provider is about to render with, on the SAME pass. An effect runs after children
   * have already committed, which would paint one frame of English place names on every switch and,
   * on the very first paint of a German session, would paint them in English before correcting.
   *
   * Writing during render is a side effect on a module, which React tolerates only because it is
   * IDEMPOTENT and derived entirely from the rendered state: the same `state.locale` produces the
   * same register, so a double invoke under StrictMode and a discarded concurrent render both leave
   * it exactly where the committed render wants it. The guard on `last` keeps it from rebuilding
   * translators on every unrelated re-render.
   */
  const last = useRef<Messages | null>(null);
  if (last.current !== state.messages) {
    last.current = state.messages;
    setActiveCatalog(state.locale, state.messages);
  }

  /* `<html lang>` was stamped by the server for the locale it rendered; a client switch has to
     move it, because it is what a screen reader picks a voice from and what the browser offers to
     translate against. The server render already agrees, so this is a no-op on first paint. */
  useEffect(() => {
    document.documentElement.lang = state.locale;
  }, [state.locale]);

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
