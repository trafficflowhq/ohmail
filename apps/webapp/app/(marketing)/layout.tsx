import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { setRequestLocale } from "next-intl/server";
import { DEFAULT_LOCALE } from "../shell/locale";
import { MARKETING_VIEWPORT, MarketingRoot, marketingMetadata } from "./marketing-root";
import "./landing.css";
/* the face layer AFTER the base sheet: its rules override on order where specificity ties */
import "./landing-face.css";

/*
 * ONE OF THE THREE ROOT LAYOUTS of the single-origin app — the ENGLISH marketing tree.
 *
 * `ohmail.app` serves the marketing site AND the product from one origin. Next's
 * multiple-root-layout feature is what keeps them from bleeding into each other:
 * this file is the <html> of `/`, `/privacy`, `/imprint`, `/subprocessors` and the
 * branded 404; `(marketing-de)/layout.tsx` is the <html> of `/de`;
 * `(product)/layout.tsx` is the <html> of everything under `(product)`. None of them
 * inherits another's <body> class, <head> metadata or GLOBAL CSS.
 *
 * The CSS separation is the load-bearing half of the marketing/product split and the
 * reason the merge is shaped this way rather than as one layout with a conditional
 * subtree. `landing.css` and `app.css` both style `html`, `body` and `.btn`; a single
 * layout that could render either would put both stylesheets on the same document and
 * let source order decide what the marketing page looks like. Here `/` (this group)
 * links landing.css only, and the signed-in `/` — which `middleware.ts` rewrites to
 * `(product)/mailbox` — links app.css only. See `app/session-gate.ts` for the decision
 * itself.
 *
 * The German half of the split is a different argument and it is written out in
 * `marketing-root.tsx`: a root layout cannot see its own pathname, so the locale has to
 * be a literal in the layout that renders it, and both trees stay static as a result.
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
