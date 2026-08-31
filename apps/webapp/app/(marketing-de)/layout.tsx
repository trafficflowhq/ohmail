import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { setRequestLocale } from "next-intl/server";
import type { AppLocale } from "../shell/locale";
import { RememberLocale } from "../(marketing)/components/RememberLocale";
import {
  MARKETING_VIEWPORT, MarketingRoot, marketingMetadata,
} from "../(marketing)/marketing-root";
import "../(marketing)/landing.css";
import "../(marketing)/landing-face.css";

/*
 * THE GERMAN MARKETING TREE — a root layout, a mount at `/de`, and deliberately nothing else.
 *
 * `messages/de.json` has held full key parity with `messages/en.json` for months, landing
 * namespaces included, and a guard keeps it there. Until this group existed none of it was
 * REACHABLE: the request config pinned English, the marketing root layout hard-wired
 * `lang="en"`, and there was no address a German reader could be sent or link to. A complete
 * translation nobody can open is not a translation.
 *
 * ── WHY A WHOLE ROOT LAYOUT FOR ONE PAGE ───────────────────────────────────────────────────
 *
 * `<html lang>` is written by the root layout, and an App Router layout is not told which path
 * it is rendering. So a single marketing root layout could only learn the language by reading a
 * cookie or `Accept-Language` per request — which makes the landing dynamic and ends its CDN
 * cache. Two root layouts, each holding its locale as a literal, keep both trees static. The
 * full argument, and why next-intl's `app/[locale]/…` shape is ruled out by the single-origin
 * merge, is in `(marketing)/marketing-root.tsx`.
 *
 * ── WHAT THIS GROUP MAY CONTAIN ────────────────────────────────────────────────────────────
 *
 * Routing. Nothing else. Every section, stylesheet, image and constant comes from
 * `(marketing)`, so there is exactly one landing composition and one set of marketing sources
 * for every guard that sweeps them — the off-origin scan, the competitor sweep, the claims
 * checks. A component that existed only here would be marketing copy outside all of them.
 *
 * ── WHAT IS NOT TRANSLATED, AND WHY THAT IS NOT AN OVERSIGHT ───────────────────────────────
 *
 * `/privacy`, `/imprint` and `/subprocessors` have no German twin. Their text is the binding
 * legal text of the Swiss operator and is deliberately kept out of the catalogue (see
 * `(marketing)/privacy/page.tsx`); a translated policy would be a second legal document, not a
 * second rendering of one. The German footer therefore links to the English originals, which is
 * the honest arrangement rather than a gap.
 */

const LOCALE = "de" satisfies AppLocale;

export function generateMetadata(): Promise<Metadata> {
  return marketingMetadata(LOCALE);
}

export const viewport: Viewport = MARKETING_VIEWPORT;

export default function GermanRootLayout({ children }: { children: ReactNode }) {
  /* Same reason as the English layout: the sections are server components, their
     `useTranslations` resolves through `i18n/request.ts`, and this call is what that config
     reads instead of a request header — which keeps `/de` a static prerender. */
  setRequestLocale(LOCALE);
  return (
    <MarketingRoot locale={LOCALE}>
      {/* Every WORD of this tree is German. The demo iframe, `/login` and `/join` are product
          routes that read the reader's cookie instead, so arriving here records the choice —
          once, and never over an explicit one. See the component. */}
      <RememberLocale locale={LOCALE} />
      {children}
    </MarketingRoot>
  );
}
