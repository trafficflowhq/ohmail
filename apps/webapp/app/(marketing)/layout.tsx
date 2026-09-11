import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { setRequestLocale } from "next-intl/server";
import { DEFAULT_LOCALE } from "../shell/locale";
import { MARKETING_VIEWPORT, MarketingRoot, marketingMetadata } from "./marketing-root";
import "./landing.css";
/* the face layer AFTER the base sheet: its rules override on order where specificity ties */
import "./landing-face.css";

/**
 * One of the three root layouts of the single-origin app — the ENGLISH marketing tree. Next's multiple-root-layout
 * feature keeps marketing and product from bleeding into each other: this file is the <html> of `/`, `/privacy`,
 * `/imprint`, `/subprocessors` and the branded 404; `(marketing-de)/layout.tsx` is `/de`'s; `(product)/layout.tsx` is
 * the rest. None inherits another's <body> class, <head> metadata or global CSS.
 */

/**
 * The CSS separation is the load-bearing half: `landing.css` and `app.css` both style `html`, `body` and `.btn`, and
 * a single layout that could render either would let source order decide what the marketing page looks like — `/`
 * links landing.css only, the signed-in `/` (rewritten to `(product)/mailbox`) links app.css only
 * (`app/session-gate.ts`). The German half's argument is in `marketing-root.tsx`: a root layout cannot see its own
 * pathname, so the locale is a literal and both trees stay static.
 */

export function generateMetadata(): Promise<Metadata> {
  return marketingMetadata(DEFAULT_LOCALE);
}

export const viewport: Viewport = MARKETING_VIEWPORT;

export default function RootLayout({ children }: { children: ReactNode }) {
  /* PIN THE LOCALE BEFORE ANY CHILD RENDERS. The marketing sections are server components
     whose `useTranslations` resolves through `i18n/request.ts`, and that config now reads
     `requestLocale` — which is this call, or a `headers()` read if nobody made it. The
     header read is not merely slower: it opts the whole route into DYNAMIC rendering, which
     would end the CDN cache the anonymous `/` depends on. Static rendering here is the
     product of this one line. */
  setRequestLocale(DEFAULT_LOCALE);
  return <MarketingRoot locale={DEFAULT_LOCALE}>{children}</MarketingRoot>;
}
