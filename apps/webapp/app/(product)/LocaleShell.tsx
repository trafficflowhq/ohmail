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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IntlErrorCode, NextIntlClientProvider, type IntlError } from "next-intl";
import { LocaleContext, type LocaleControls } from "../shell/LocaleContext";
import {
  LOCALES, normalizeLocale, rememberLocale, setActiveCatalog, type AppLocale,
} from "../shell/locale";
import { loadCatalog, loadWholeCatalog, type Messages } from "../../i18n/catalog";

/**
 * The document carries only the first screen's cut (`i18n/first-screen.ts`); the whole catalogue
 * is a hashed chunk, asked for HERE as this module evaluates in a browser — before hydration, not
 * after its commit. `<html lang>` is the locale the server resolved, so this is the catalogue the
 * mount below wants; a document without one starts nothing. Handled, so an unused refusal is quiet.
 */
const early: { locale: AppLocale; catalog: Promise<Messages> } | null = (() => {
  if (typeof document === "undefined") return null;
  const locale = normalizeLocale(document.documentElement.lang);
  if (locale === null) return null;
  const catalog = loadWholeCatalog(locale);
  catalog.catch(() => {});
  return { locale, catalog };
})();

/** A refused chunk is asked for again after this long, doubling, never slower than the cap. */
const RETRY_FIRST_MS = 500;
const RETRY_CAP_MS = 30_000;

/**
 * Until the whole catalogue lands, a namespace the document did not carry is MISSING by design:
 * it renders nothing — never its dotted key — and is not reported. Any other intl error still is.
 */
function quietWhilePending(error: IntlError): void {
  if (error.code === IntlErrorCode.MISSING_MESSAGE) return;
  console.error(error);
}
const PENDING = { onError: quietWhilePending, getMessageFallback: (): string => "" } as const;

export function LocaleShell({
  initialLocale,
  initialMessages,
  children,
}: {
  initialLocale: AppLocale;
  initialMessages: Messages;
  children: ReactNode;
}) {
  /* `complete`: the messages are the whole catalogue. The layout's are the cut, so never at first. */
  const [state, setState] = useState<{ locale: AppLocale; messages: Messages; complete: boolean }>({
    locale: initialLocale,
    messages: initialMessages,
    complete: false,
  });
  const [busy, setBusy] = useState(false);

  /**
   * The rest of the catalogue, once, for the locale the document rendered in. A switch that landed
   * first wins — its catalogue is already whole and newer. A refused chunk is asked for again with
   * a doubling wait, so a flaky connection costs time, never the copy.
   */
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number): void => {
      const ask = n === 0 && early?.locale === initialLocale ? early.catalog : loadWholeCatalog(initialLocale);
      ask.then((messages) => {
        if (stopped) return;
        setState((s) => (s.complete || s.locale !== initialLocale ? s : { locale: s.locale, messages, complete: true }));
      }, () => {
        if (!stopped) timer = setTimeout(() => attempt(n + 1), Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** n));
      });
    };
    attempt(0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [initialLocale]);

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
    setState({ locale: next, messages, complete: true });
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

  /**
   * THE ZONE THE PROVIDER STATES. Without it every `format.dateTime` THROWS `ENVIRONMENT_FALLBACK`,
   * which next-intl catches and then formats in the environment's zone anyway — Settings → Devices
   * formats two dates per row, so opening it cost 24 thrown-and-caught errors and 24 console lines
   * for dates that were already right. This resolves the SAME zone that fallback resolves, so no
   * rendered time moves: it removes the throw, not the behaviour. `UTC` only where the environment
   * will not name one, which is the one honest default — never a guess at somebody's zone. A zone
   * the ACCOUNT states is a different question and is not answered here.
   */
  const zone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
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
      <NextIntlClientProvider
        locale={state.locale}
        messages={state.messages}
        timeZone={zone}
        {...(state.complete ? {} : PENDING)}
      >
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
