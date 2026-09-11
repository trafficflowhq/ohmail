"use client";

import { useLocale, useTranslations } from "next-intl";
import { DEFAULT_LOCALE, normalizeLocale, rememberLocale, type AppLocale } from "../../shell/locale";
import { useSessionPresence } from "./session-presence";

/**
 * The language switch on the marketing site — a link, first and foremost: the German landing is a
 * real address (`/de`), so the way to it is a real `<a href>` — what a crawler follows, a keyboard
 * reaches, a middle click opens, and what works without our JavaScript. No new copy: the label is
 * the OTHER language's name in that language ("Deutsch" on the English page) — a reader scans for
 * their own word, and both strings already exist as `settings.languageName`, pinned by
 * `locale-catalog.test.ts` as the two sentences never translated. `hrefLang` describes the DOCUMENT
 * at the other end; `lang` describes the link's own text, so a screen reader pronounces "Deutsch"
 * with German phonemes.
 */

/**
 * Not offered to a browser with a session: `/` is the English address AND the mail client for a
 * validated session, so for a signed-in browser this link opens the app — and the href cannot
 * change, because it must equal the `hreflang="en"` alternate, which is `/`. The control steps
 * aside instead, through the same seam `Nav.tsx` uses; a signed-in reader changes language in
 * Settings, on the account. `useSessionPresence` reads the `tf_owner` marker after mount and the
 * first client render answers "none" regardless, so the server render and every crawler still see
 * the link — which keeps `/de` linked rather than merely reachable.
 */

/**
 * The click also records the preference — through `rememberLocale`, the single writer, host-only
 * with no `Domain=`; a second writer is how a cookie gets quietly widened. Best-effort and not the
 * navigation: the `<a>` carries the reader either way. `onClick` covers primary click and keyboard;
 * a middle click fires only `onAuxClick` — but `auxclick` fires for EVERY non-primary button, and
 * unguarded, right-clicking the link changed the language of every later product route while the
 * page did not move; the handler is gated on button 1, the only aux button that navigates. One
 * residual, recorded: the context menu's "Open in new tab" fires no handler, so that tab's `/de`
 * records German while `/` records nothing — English is the resting state, never written down.
 */

/** The other locale, for each locale. Exhaustive over the closed set by construction. */
const OTHER: Record<AppLocale, AppLocale> = { en: "de", de: "en" };

/** Where each locale's landing lives. The same pair `marketing-root.tsx` builds `hreflang` from. */
const LANDING: Record<AppLocale, string> = { en: "/", de: "/de" };

export function LangSwitch({
  className,
  landmarkClassName,
  compact,
}: {
  className: string;
  /**
   * The nav's form: the other locale's two-letter mark ("DE"/"EN") instead of the full name — the
   * header is a crowded row and "Deutsch" was the widest utility in it (owner ask, 2026-08-24:
   * subtle in the nav, the full switcher stays in the footer). The label rule survives in the
   * accessible name: `aria-label` and `title` carry the language's own word for itself, from the
   * same `settings.languageName` pair, so a screen reader or tooltip still meets
   * "Deutsch"/"English" — only the visible footprint shrinks. Everything else is identical: the
   * same real `<a href>`, `hrefLang`/`lang` pair, `rememberLocale` writes and session gate.
   */
  compact?: boolean;
  /**
   * When the switch is a landmark of its own, it owns the landmark — because it can now disappear,
   * and an empty named region is worse than no region. The footer gives the switch its own `<nav>`
   * so it is announced ("Language" / "Sprache"); that wrapper used to live in `Footer.tsx`, where
   * it could not see the session gate, and a signed-in visit rendered a named navigation landmark
   * containing nothing at all. Passing the wrapper's class in makes the landmark and its only child
   * withdraw together, with no second copy of the gate. Omitted in the header, where the switch is
   * one control among several and its absence leaves no hole.
   */
  landmarkClassName?: string;
}) {
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
  const name = other === "de" ? t("languageName.de") : t("languageName.en");
  const link = (
    <a
      className={compact ? `${className} l-lang-mark` : className}
      href={LANDING[other]}
      hrefLang={other}
      lang={other}
      {...(compact ? { "aria-label": name, title: name } : {})}
      onClick={() => rememberLocale(other)}
      onAuxClick={(event) => { if (event.button === 1) rememberLocale(other); }}
    >
      {compact ? other.toUpperCase() : name}
    </a>
  );
  if (landmarkClassName === undefined) return link;
  /* The landmark's NAME from the catalogue, in the page's own language — the same key the
     selector in Settings uses, pinned in both catalogues by `locale-catalog.test.ts`. */
  return (
    <nav className={landmarkClassName} aria-label={t("language")}>
      {link}
    </nav>
  );
}
