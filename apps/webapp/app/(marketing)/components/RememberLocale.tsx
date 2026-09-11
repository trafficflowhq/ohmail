"use client";

import { useEffect } from "react";
import {
  localeFromCookieHeader, readStoredLocale, rememberLocale, type AppLocale,
} from "../../shell/locale";

/**
 * Arriving on a translated landing is itself a language choice — record it, once. `/de` is a static German document,
 * and three things it links to are not: the demo iframe, `/login` and `/join`, all of which resolve their language
 * from the `ohmail.locale` cookie — so a reader who reached `/de` with no cookie read a German page around an English
 * demo and an English sign-in form.
 */

/**
 * Only when nothing is stored: a stored preference is an EXPLICIT act this must never overrule — a reader who chose
 * English and opens a German link keeps English everywhere else; the write happens only from the resting state, the
 * rule the product follows (`account_settings.locale` stores NULL, nobody's default is written down). The English
 * landing has no counterpart and should not: English IS the resting state, and storing it would freeze out the
 * account preference.
 */

/**
 * Both mediums are read, and that is not belt-and-braces: `rememberLocale` writes `localStorage`
 * AND the cookie, and the storage write is the one that silently fails (private window, site data
 * off) — reading the store alone would answer "nobody has said" and overwrite an English choice
 * with German. `document.cookie` has the same `k=v; k=v` shape as the `Cookie:` header, so the
 * server render's parser reads it unchanged. An effect is enough: it runs after paint and before
 * the deferred demo iframe mounts; if a very fast scroll ever beat it, the cost is one English demo
 * frame on one visit — a server-side write would cost the page its static render. `rememberLocale`
 * is the single writer (`app/shell/locale.ts`), host-only, `Path=/`, no `Domain=`.
 */
export function RememberLocale({ locale }: { locale: AppLocale }) {
  useEffect(() => {
    if (readStoredLocale() !== null) return;
    if (localeFromCookieHeader(document.cookie) !== null) return;
    rememberLocale(locale);
  }, [locale]);
  return null;
}
