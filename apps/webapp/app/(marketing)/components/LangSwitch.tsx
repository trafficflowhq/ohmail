"use client";

import { useLocale, useTranslations } from "next-intl";
import { DEFAULT_LOCALE, normalizeLocale, rememberLocale, type AppLocale } from "../../shell/locale";
import { useSessionPresence } from "./session-presence";

/**
 * THE LANGUAGE SWITCH ON THE MARKETING SITE — a link, first and foremost.
 *
 * The German landing is a real address (`/de`, see `(marketing-de)`), so the way to it must be
 * a real `<a href>`: that is what a crawler follows, what a keyboard reaches, what a middle
 * click opens in a tab and what still works for a reader whose browser never runs our
 * JavaScript. A button that pushed a route would make the German site reachable only to the
 * subset of readers who already have everything working.
 *
 * ── NO NEW COPY, AND THE LABEL IS THE WHOLE REASON ────────────────────────────────────────
 *
 * The label is the OTHER language's name in that language — "Deutsch" on the English page,
 * "English" on the German one. That is the one thing a language switch must get right: a
 * reader looking for their language scans for their own word for it, and a switch that said
 * "German" to a German reader is a switch they cannot find. Both strings already exist as
 * `settings.languageName`, used by the selector in Settings, and `locale-catalog.test.ts`
 * pins them as the two sentences in the catalogue that must never be translated. So this
 * control introduces no marketing copy at all — it reuses the pair that was already correct.
 *
 * `hrefLang` and `lang` are both set and they say different things: `hrefLang` describes the
 * DOCUMENT at the other end (the hint a crawler pairs with the `<link rel="alternate">` in the
 * head), `lang` describes the TEXT of the link itself, so a screen reader pronounces "Deutsch"
 * with German phonemes instead of reading it as an English word.
 *
 * ── AND WHY IT IS NOT OFFERED TO A BROWSER THAT HAS A SESSION ─────────────────────────────
 *
 * `/` is the English address of this site AND the address the mail client answers on: the
 * middleware rewrites it for a validated session before anything renders. So for a signed-in
 * browser this link opens the app, not the English landing it names — and `hrefLang="en"`
 * makes that a claim about the document at the other end, not just a label.
 *
 * The href cannot be changed to fix it. It has to equal the `hreflang="en"` alternate in the
 * head, which is `/` because that IS the canonical English page, and a second marketing-only
 * English address is the thing `middleware.ts` 308s `/mailbox` back to `/` to prevent. So the
 * control steps aside instead, through the same seam `Nav.tsx` uses to collapse its
 * acquisition trio for a session. A signed-in reader changes language in Settings, where the
 * preference is stored on the account rather than on the device.
 *
 * `useSessionPresence` answers "none" until the auth slice wires it, and its first client
 * render must answer "none" regardless, so the server render and every crawler still see the
 * link — which is what keeps `/de` linked rather than merely reachable.
 *
 * ── WHY IT ALSO WRITES THE PREFERENCE, AND WHY THROUGH `rememberLocale` ───────────────────
 *
 * The marketing site and the product are one origin. A reader who switches to German and then
 * follows "Anmelden" would otherwise land on an English `/login`, because the product resolves
 * its locale from the `ohmail.locale` cookie and nothing on the landing had ever written one.
 * So the click records the choice — through `rememberLocale`, which is the single writer of
 * that preference (`app/shell/locale.ts`) and writes it host-only, `Path=/` with no `Domain=`,
 * exactly like the session cookie. This component deliberately does not touch `document.cookie`
 * itself: a second writer is how a cookie gets quietly widened.
 *
 * It is best-effort and it is not the navigation. The `<a>` carries the reader either way; if
 * storage is blocked the only cost is that the product starts in English, which is the same
 * cost every other locale-less visit has.
 *
 * BOTH ACTIVATIONS THAT CAN FIRE A HANDLER DO. `onClick` covers a primary click and the
 * keyboard; a MIDDLE click fires `onAuxClick` and not `onClick`, so "open the other language in
 * a new tab" used to switch the page and leave the product on the old language. One residual is
 * not reachable from here and is recorded rather than papered over: the context menu's "Open
 * link in a new tab" fires no handler at all, so that tab's `/de` still records German through
 * `RememberLocale` while that tab's `/` records nothing — English is the resting state and is
 * deliberately never written down (`app/shell/locale.ts`).
 */

/** The other locale, for each locale. Exhaustive over the closed set by construction. */
const OTHER: Record<AppLocale, AppLocale> = { en: "de", de: "en" };

/** Where each locale's landing lives. The same pair `marketing-root.tsx` builds `hreflang` from. */
const LANDING: Record<AppLocale, string> = { en: "/", de: "/de" };

export function LangSwitch({ className }: { className: string }) {
  const t = useTranslations("settings");
  const presence = useSessionPresence();
  /* `useLocale()` answers whatever the enclosing provider was built with, which is the root
     layout's literal. Normalized anyway: the hook's return type is a bare string, and a value
     outside the closed set must degrade to English rather than index the maps with `undefined`. */
  const here = normalizeLocale(useLocale()) ?? DEFAULT_LOCALE;
  const other = OTHER[here];
  /* After every hook, never before one: an early return above `useLocale` would change the
     hook order between the stranger render and the signed-in one. */
  if (presence === "present") return null;
  return (
    <a
      className={className}
      href={LANDING[other]}
      hrefLang={other}
      lang={other}
      onClick={() => rememberLocale(other)}
      onAuxClick={() => rememberLocale(other)}
    >
      {other === "de" ? t("languageName.de") : t("languageName.en")}
    </a>
  );
}
