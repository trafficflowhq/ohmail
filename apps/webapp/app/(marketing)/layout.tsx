import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import { Providers } from "./providers";
import "./landing.css";

/*
 * ONE OF THE TWO ROOT LAYOUTS of the single-origin app.
 *
 * `ohmail.app` serves the marketing site AND the product from one origin. Next's
 * multiple-root-layout feature is what keeps them from bleeding into each other:
 * this file is the <html> of everything under `(marketing)`, `(product)/layout.tsx`
 * is the <html> of everything under `(product)`, and NEITHER inherits the other's
 * <body> class, <head> metadata or GLOBAL CSS.
 *
 * The CSS separation is the load-bearing half and the reason the merge is shaped this
 * way rather than as one layout with a conditional subtree. `landing.css` and
 * `app.css` both style `html`, `body` and `.btn`; a single layout that could render
 * either would put both stylesheets on the same document and let source order decide
 * what the marketing page looks like. Here `/` (this group) links landing.css only,
 * and the signed-in `/` — which `middleware.ts` rewrites to `(product)/mailbox` —
 * links app.css only. See `app/session-gate.ts` for the decision itself.
 */

/* The "oh." mark — outlined lowercase ink letters, terracotta period, on the
   canvas tile. Masters and the full asset set live in design/icon/oh; the
   files here are copies in public/, kept byte-identical by `npm run sync`
   in design/ and asserted by `npm run icon:check`.

   Order is deliberate. The .ico comes first because it is the only asset
   that can carry pixel hinting: its 16px frame is grid-snapped, which an
   SVG cannot be. Chrome and Firefox will prefer the SVG anyway — so the SVG
   is generated from the same small-size cut rather than from the display
   one, and either choice is legible at 16px. The 192/512 PNGs carry the
   display cut with its full margin, and their `sizes` keep the small assets
   from being stretched onto a large surface. */
const ICONS: Metadata["icons"] = {
  icon: [
    { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
    { url: "/favicon.svg", type: "image/svg+xml" },
    { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
    { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
  ],
  apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
};

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("siteMeta");
  return {
    metadataBase: new URL("https://ohmail.app"),
    title: t("title"),
    description: t("description"),
    icons: ICONS,
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: "/",
      siteName: "ohmail",
      type: "website",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: t("ogAlt") }],
    },
    twitter: {
      card: "summary_large_image",
      title: t("title"),
      description: t("description"),
      images: ["/og.png"],
    },
    robots: { index: true, follow: true },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  /* the canvas tokens, so the browser chrome matches the tile the icon sits
     on. The manifest carries one theme_color and cannot switch; this can. */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0b08" },
  ],
};

/* Stamp the persisted theme before first paint (same contract as
   @ohmail/ui ThemeProvider: absent attribute = follow the system). */
const THEME_BOOT = `(function(){try{var t=localStorage.getItem("ohmail.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}})()`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="mo-canvas l-body">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
