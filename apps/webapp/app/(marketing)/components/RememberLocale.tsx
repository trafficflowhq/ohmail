"use client";

import { useEffect } from "react";
import {
  localeFromCookieHeader, readStoredLocale, rememberLocale, type AppLocale,
} from "../../shell/locale";

/**
 * ARRIVING ON A TRANSLATED LANDING IS ITSELF A LANGUAGE CHOICE — record it, once.
 *
 * `/de` is a static German document and every word ON it is German. Three things it links to
 * or embeds are NOT: the demo iframe (`/demo`), `/login` and `/join`. All three are product
 * routes, and the product resolves its language from the `ohmail.locale` cookie
 * (`(product)/layout.tsx`) — so a reader who reached `/de` from a search result, with no cookie
 * yet, would read a German page around an English demo and then be handed an English sign-in
 * form. The German is complete; only the handover was missing.
 *
 * ── WHY ONLY WHEN NOTHING IS STORED ────────────────────────────────────────────────────────
 *
 * A stored preference is an EXPLICIT act — the switch in the nav, or the selector in Settings —
 * and this must never overrule one. A reader who chose English and then opens a German link
 * (someone sent it to them; they wanted to see it) keeps English everywhere else. So the write
 * happens only from the resting state, which is also the rule the rest of the product follows:
 * `account_settings.locale` stores NULL rather than `'en'`, and nobody's default is ever
 * written down.
 *
 * BOTH MEDIUMS ARE READ, and that is not belt-and-braces. `rememberLocale` writes
 * `localStorage` AND the cookie, and the storage write is the one that silently fails — a
 * private window, a webview with site data off, a reader who cleared storage but kept cookies.
 * In every one of those the cookie is the only surviving record of an explicit choice, so
 * reading the store alone answers "nobody has said" and this effect would overwrite an English
 * choice with German the moment somebody opened a German link. `document.cookie` has the same
 * `k=v; k=v` shape as the `Cookie:` header, so the server render's parser reads it unchanged
 * rather than a second one being written here.
 *
 * The English landing has no counterpart to this and should not: English IS the resting state,
 * so storing it would turn "nobody has said" into "they said English" and freeze out exactly
 * the account preference that is supposed to follow a reader between machines.
 *
 * ── AND WHY AN EFFECT IS ENOUGH ────────────────────────────────────────────────────────────
 *
 * It runs after hydration, which is after the document is painted and — on this page — before
 * the demo iframe mounts, because that iframe is deliberately deferred until its section
 * approaches the viewport (see `DemoSection`). If a very fast scroll ever beat it, the cost is
 * one English demo frame on one visit and nothing else: the cookie is written either way and
 * the next load is German. A server-side write would have cost the page its static render,
 * which is not a trade worth making for that.
 *
 * `rememberLocale` is the single writer of the preference (`app/shell/locale.ts`); it writes
 * `Path=/` with no `Domain=`, host-only, exactly like the session cookie. Nothing here touches
 * `document.cookie` directly — a second writer is how a cookie gets quietly widened.
 */
export function RememberLocale({ locale }: { locale: AppLocale }) {
  useEffect(() => {
    if (readStoredLocale() !== null) return;
    if (localeFromCookieHeader(document.cookie) !== null) return;
    rememberLocale(locale);
  }, [locale]);
  return null;
}
