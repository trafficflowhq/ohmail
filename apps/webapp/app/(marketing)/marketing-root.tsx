import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { loadCatalog } from "../../i18n/catalog";
import { CANONICAL_ORIGIN } from "../canonical-host";
import type { AppLocale } from "../shell/locale";
import { Providers } from "./providers";

/**
 * The marketing shell, once — shared by the root layouts that mount it. The marketing site is bilingual,
 * and `<html lang>` is decided by the ROOT layout, the one place an App Router tree cannot see which path
 * it renders. A single marketing root could only learn the language by reading something per request,
 * which `i18n/request.ts` refuses for this group: it would end the static prerender and the CDN cache,
 * one URL with two bodies and no `hreflang`. next-intl's `app/[locale]/…` is ruled out by the merge: `/`
 * is the landing to a stranger and the mail client to a signed-in browser, chosen by a rewrite. So each
 * locale gets a root layout knowing its locale as a literal, both stay static, and this module is the
 * body they share — `(marketing-de)` contributes routing and nothing else.
 */

/* The "oh." mark — outlined lowercase ink letters, terracotta period, on the canvas tile. Masters
   live in design/icon/oh; the files here are copies in public/, kept byte-identical by `npm run
   sync` in design/ and asserted by `npm run icon:check`. Order is deliberate: the .ico comes first
   because it is the only asset that can carry pixel hinting (its 16px frame is grid-snapped, which
   an SVG cannot be). Chrome and Firefox prefer the SVG anyway — so the SVG is generated from the
   same small-size cut, and either choice is legible at 16px. The 192/512 PNGs carry the display cut
   with its full margin, and their `sizes` keep the small assets off large surfaces. */
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
 * The `hreflang` set, built from that map rather than written out twice. Two hand-written alternate
 * blocks drift: one page learns about a new locale and the other does not, the pair stops being
 * reciprocal, and a search engine drops the whole cluster — silently, because both pages still
 * render. Built here, the two are the same object with a different `canonical`. `x-default` is
 * English: what a reader whose language we do not publish should be given. Every value is a PATH,
 * never an absolute URL — `metadataBase` is {@link CANONICAL_ORIGIN}, imported from the module that
 * owns the one-origin rule, so the head can only ever name this origin.
 */
export function marketingAlternates(locale: AppLocale): Metadata["alternates"] {
  return {
    canonical: MARKETING_PATH[locale],
    languages: { ...MARKETING_PATH, "x-default": MARKETING_PATH.en },
  };
}

/**
 * The head of a marketing document, in one locale. `getTranslations` is called with an EXPLICIT
 * locale rather than through the request config: `generateMetadata` and the layout body are
 * separate entry points into the same render with no promised ordering, so an implicit resolution
 * would depend on something this file cannot see — and passing it keeps `headers()` out of a static
 * route's head. No `alternates` here, deliberately: Next merges metadata field by field and a child
 * inherits what it does not set, so a `canonical` on the layout would make `/privacy`, `/imprint`
 * and `/subprocessors` each declare itself a duplicate of the landing. {@link marketingAlternates}
 * is applied by the two landing pages, the only documents with a translation to point at.
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

/* Stamp the persisted theme AND the face before first paint (same contract as @ohmail/ui
   ThemeProvider: absent attribute = follow the system / = paper). The face half re-encodes the
   provider's resolution order — device pin (`ohmail.face`), account mirror (`ohmail.face.account`),
   Linux-desktop detection (the §5 wedge; the regexes must match `linuxDesktopDevice`) — with one
   marketing-only head in front: a `#face=` fragment, the landing's addressable face (the README's
   "see it live" opens `/#face=ohmarchy`), treated as the visitor's own choice arriving by URL, so
   it writes the device pin exactly as a toggle press would. Detection never persists: an auto-flip
   must stay revisable by a later account echo. Every storage read sits in its own try — a blocked
   jar falls through to detection rather than skipping it. No layout axis: nothing on the marketing
   document consumes `data-layout`. */
const THEME_BOOT =
  `(function(){try{var t=localStorage.getItem("ohmail.theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}` +
  /* NO backslash escapes in this script, measured: the build chain re-parsed a `\b`
     word boundary in this template literal into a literal backspace byte (0x08) in the
     served HTML, which silently broke the whole regex. `(?![a-z])` is the same trailing
     boundary with no escape character in it. */
  /* ONE-SHOT (review-caught): the fragment is consumed — pin written, hash stripped —
     or a reload would replay the link's choice OVER a newer one the visitor made with
     the toggle, breaking "an explicit prior choice always wins".
     CONSUMED ONLY IF IT WAS KEPT (review round 2): when the jar is blocked or full the
     setItem throws, and stripping the hash anyway destroys the only remaining record of
     the visitor's choice — the next paint resolves from the account or detection and the
     link can no longer be retried or shared onward. So the strip is gated on the write
     having succeeded; a blocked jar keeps the fragment, and the face it asked for still
     applies to THIS pageview through `f` below. */
  `var m=/[#&]face=(paper|ohmarchy)(?![a-z])/.exec(location.hash||"");var f=m?m[1]:null;` +
  `if(f){var kept=0;try{localStorage.setItem("ohmail.face",f);kept=1}catch(e){}` +
  `if(kept)try{history.replaceState(null,"",location.pathname+location.search)}catch(e){}}` +
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
