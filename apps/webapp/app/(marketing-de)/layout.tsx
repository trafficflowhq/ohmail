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

/**
 * The German marketing tree — a root layout, a mount at `/de`, and deliberately nothing else. `messages/de.json` has
 * held full key parity for months; until this group existed none of it was REACHABLE — a complete translation nobody
 * can open is not a translation. A whole root layout for one page because `<html lang>` is written by the root
 * layout, and a layout is not told which path it renders — one marketing root could only learn the language per
 * request, ending the CDN cache; two layouts, each holding its locale as a literal, keep both trees static (the full
 * argument is in `(marketing)/marketing-root.tsx`).
 */

/**
 * This group may contain ROUTING and nothing else: every section, stylesheet and constant comes from `(marketing)`,
 * so the sweeping guards cover one set of sources. `/privacy`, `/imprint` and `/subprocessors` have no German twin,
 * deliberately: their text is the operator's binding legal text, and a translated policy would be a second legal
 * document — the German footer links the English originals.
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
