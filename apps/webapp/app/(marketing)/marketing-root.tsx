import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { loadCatalog } from "../../i18n/catalog";
import { CANONICAL_ORIGIN } from "../canonical-host";
import type { AppLocale } from "../shell/locale";
import { Providers } from "./providers";

/**
 * THE MARKETING SHELL, ONCE — SHARED BY THE TWO ROOT LAYOUTS THAT MOUNT IT.
 *
 * `ohmail.app` serves the marketing site and the product from one origin, and Next's
 * multiple-root-layout feature is what keeps them from bleeding into each other. That was two
 * layouts (`(marketing)`, `(product)`); it is three now, because the marketing site is
 * bilingual and `<html lang>` is decided by the ROOT layout — the one place in an App Router
 * tree that cannot see which path it is rendering.
 *
 * ── WHY THE LOCALE HAS TO BE A SECOND ROOT LAYOUT AND NOT A SEGMENT ────────────────────────
 *
 * A layout receives no pathname. So a single marketing root layout can only learn the reader's
 * language by READING SOMETHING PER REQUEST — a cookie or `Accept-Language` — and that is
 * exactly what `i18n/request.ts` refuses on this group's behalf: `cookies()`/`headers()` opts
 * the caller into dynamic rendering, which would turn the landing, `/privacy`, `/imprint` and
 * `/subprocessors` into functions, end the CDN cache the session gate depends on, and give one
 * URL two bodies with no `hreflang` and no separate address to point a crawler at.
 *
 * The other standard shape — next-intl's `app/[locale]/…` plus its routing middleware — is
 * ruled out by the merge: it puts a prefix on EVERY path and needs a redirect on the bare apex,
 * and `/` here is the landing to a stranger and the mail client to a signed-in browser, chosen
 * by a rewrite before anything renders. Moving the landing to `/en` would give the product's
 * front door a second address and a redirect in front of it.
 *
 * So each locale gets a root layout that KNOWS its locale as a literal, both stay static, and
 * this module is the body they share: the same `<html>`, the same theme boot, the same
 * provider, the same head. `(marketing-de)` therefore contributes routing and nothing else —
 * every section, stylesheet and asset it renders comes from `(marketing)`.
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

/**
 * WHERE EACH LOCALE'S LANDING LIVES — the one map, and the reason it is typed this way.
 *
 * `Record<AppLocale, string>` over the closed set in `app/shell/locale.ts`: adding a locale to
 * `LOCALES` without giving it an address is a COMPILE ERROR here, rather than a `hreflang` that
 * silently names a locale with no page and a catalogue nobody can reach. English keeps the bare
 * path — it is the origin's front door and the address every existing link, mail and bookmark
 * points at, and no locale slice may move it.
 */
export const MARKETING_PATH: Record<AppLocale, string> = { en: "/", de: "/de" };

/**
 * THE `hreflang` SET, BUILT FROM THAT MAP RATHER THAN WRITTEN OUT TWICE.
 *
 * Two hand-written alternate blocks drift: one page learns about a new locale and the other
 * does not, the pair stops being reciprocal, and a search engine drops the whole cluster —
 * silently, because both pages still render perfectly. Built here, the two are the same object
 * with a different `canonical`.
 *
 * `x-default` is English: it is what a reader whose language we do not publish should be given,
 * and it is the address that already carries the product.
 *
 * Every value is a PATH, never an absolute URL. `metadataBase` is {@link CANONICAL_ORIGIN} —
 * imported from the module that OWNS the one-origin rule rather than re-typed — so the head can
 * only ever name this origin, and a second host cannot enter the marketing site through a
 * hard-coded alternate.
 */
export function marketingAlternates(locale: AppLocale): Metadata["alternates"] {
  return {
    canonical: MARKETING_PATH[locale],
    languages: { ...MARKETING_PATH, "x-default": MARKETING_PATH.en },
  };
}

/**
 * The head of a marketing document, in one locale.
 *
 * `getTranslations` is called with an EXPLICIT locale rather than through the request config.
 * `generateMetadata` and the layout body are separate entry points into the same render, and
 * nothing in the framework promises the layout runs first — so a metadata call that resolved
 * the locale implicitly would depend on an ordering this file cannot see. Passing it removes
 * the question, and it also keeps `headers()` out of a static route's head.
 *
 * NO `alternates` HERE, DELIBERATELY. Next merges metadata field by field and a child inherits
 * every field it does not set, so a `canonical` on the LAYOUT would be inherited by `/privacy`,
 * `/imprint` and `/subprocessors` — each of them then declaring itself a duplicate of the
 * landing. {@link marketingAlternates} is applied by the two landing PAGES, which are the only
 * documents that have a translation to point at.
 */
export async function marketingMetadata(locale: AppLocale): Promise<Metadata> {
  const t = await getTranslations({ locale, namespace: "siteMeta" });
  return {
    metadataBase: new URL(CANONICAL_ORIGIN),
    title: t("title"),
    description: t("description"),
    icons: ICONS,
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: MARKETING_PATH[locale],
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

export const MARKETING_VIEWPORT: Viewport = {
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

/* Stamp the persisted theme AND the face before first paint (same contract as
   @ohmail/ui ThemeProvider: absent attribute = follow the system / = paper).

   The face half re-encodes the provider's resolution order — device pin (`ohmail.face`),
   account mirror (`ohmail.face.account`), Linux-desktop detection (the §5 wedge; the
   regexes must match `linuxDesktopDevice`) — with ONE marketing-only head in front of it:
   a `#face=` fragment. That fragment is the landing's addressable face — the GitHub
   README's "see it live" link opens `/#face=ohmarchy` — and it is treated as the
   visitor's OWN choice arriving by URL, so it writes the device pin exactly as a toggle
   press would (remembered, one click back, and the provider adopts the same pin
   post-mount so hydration agrees). Detection, by contrast, never persists: an auto-flip
   must stay revisable by a later account echo, and the wink depends on "nobody chose".

   Every storage read sits in its own try — a blocked jar falls through to detection
   rather than skipping it (themeInitScript's review-caught rule). The layout axis is
   deliberately absent: nothing on the marketing document consumes `data-layout`. */
const THEME_BOOT =
  `(function(){try{var t=localStorage.getItem("ohmail.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}` +
  /* NO backslash escapes in this script, measured: the build chain re-parsed a `\b`
     word boundary in this template literal into a literal backspace byte (0x08) in the
     served HTML, which silently broke the whole regex. `(?![a-z])` is the same trailing
     boundary with no escape character in it. */
  `var m=/[#&]face=(paper|ohmarchy)(?![a-z])/.exec(location.hash||"");var f=m?m[1]:null;` +
  `if(f){try{localStorage.setItem("ohmail.face",f)}catch(e){}}` +
  `if(f!=="paper"&&f!=="ohmarchy"){try{f=localStorage.getItem("ohmail.face")}catch(e){}}` +
  `if(f!=="paper"&&f!=="ohmarchy"){try{f=localStorage.getItem("ohmail.face.account")}catch(e){}}` +
  `if(f!=="paper"&&f!=="ohmarchy")f=(/Linux/.test(navigator.platform||"")&&!/Android|CrOS/.test(navigator.userAgent||""))?"ohmarchy":"paper";` +
  `if(f==="ohmarchy")try{document.documentElement.dataset.face="ohmarchy"}catch(e){}})()`;

/**
 * The `<html>` of a marketing document.
 *
 * The catalogue is loaded for the locale it was GIVEN — not through `getLocale()`/`getMessages()`,
 * which resolve via the request config. Those would work, and they would also make it possible
 * for the client provider and the `<html lang>` two lines above it to disagree, which is the one
 * bug this shell exists to make unrepresentable. The request config still matters and is still
 * correct: the marketing sections are SERVER components whose `useTranslations` reads it, which
 * is why each root layout pins the same locale with `setRequestLocale` before rendering this.
 */
export async function MarketingRoot(
  { locale, children }: { locale: AppLocale; children: ReactNode },
) {
  const messages = await loadCatalog(locale);
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
