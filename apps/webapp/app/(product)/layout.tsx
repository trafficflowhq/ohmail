import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { LocaleShell } from "./LocaleShell";
import { Providers } from "./providers";
import { DEFAULT_LOCALE, localeFromCookieHeader } from "../shell/locale";
import { loadCatalog } from "../../i18n/catalog";
import "../app.css";

/*
 * THE OTHER ROOT LAYOUT of the single-origin app — see
 * `(marketing)/layout.tsx` for why there are two and what that buys.
 *
 * Everything under `(product)` renders inside this <html>: `/login`, `/join`, and
 * `mailbox/page.tsx`, which is what a signed-in `/` becomes after `middleware.ts`
 * rewrites it. `app.css` is linked HERE and only here, so the marketing page never
 * carries it and its `html`/`body`/`.btn` rules can never reach the landing.
 *
 * `app.css` stays at `app/app.css` rather than moving in beside this file because
 * `apps/desktop` imports it verbatim (`src/main.tsx`) and `scripts/publish-desktop.mjs`
 * copies it by path into the public mirror. The same is true of `app/shell` and
 * `app/views`: the route files moved into this group, the SHARED shell did not.
 */

/* The "oh." mark — the same asset set the marketing group declares, out of the
   same public/ (design/icon/oh, copied by `npm run sync` in design/). Declared
   twice because there is no shared root layout to declare it once; see the note
   in `(marketing)/layout.tsx` for why the .ico is first and why favicon.svg
   carries the small-size cut. */
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
  const t = await getTranslations("meta");
  return {
    metadataBase: new URL("https://ohmail.app"),
    title: t("title"),
    description: t("description"),
    icons: ICONS,
    /* Unfurl cards and search indexing are two different decisions, and this
       file used to make only the second one. `noindex` keeps the app shell out
       of search results — and under one origin that is now the only thing that
       does. `/` is a SINGLE URL serving the marketing page to a crawler (which
       is never signed in, so it always gets `(marketing)`'s indexable metadata)
       and this shell to a session; whichever one rendered is what the <head>
       describes. It says nothing about what happens when somebody pastes
       https://ohmail.app into Slack, iMessage or a mail thread — that paste is
       anonymous too, and gets the landing's 1200×630 card.

       So: a `summary` card, not `summary_large_image`. The landing owns the
       1200×630 og.png with the headline in it, because the landing is the thing
       being sold. This is the app you already decided to use — the honest card
       is the "oh." tile at icon size, the same mark that sits in the dock and
       the browser tab, plus the name and one line of what it is. Anything wider
       would be borrowing marketing weight the shell has not earned. */
    openGraph: {
      title: t("title"),
      description: t("description"),
      url: "/",
      siteName: "ohmail",
      type: "website",
      images: [{ url: "/icon-512.png", width: 512, height: 512, alt: t("ogAlt") }],
    },
    twitter: {
      card: "summary",
      title: t("title"),
      description: t("description"),
      images: ["/icon-512.png"],
    },
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
  /* the canvas tokens — the browser chrome matches the tile the icon sits on */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfaf9" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0b08" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  /*
   * THE LOCALE, RESOLVED HERE RATHER THAN IN `i18n/request.ts`.
   *
   * `getLocale()`/`getMessages()` go through next-intl's request config, which is shared with the
   * `(marketing)` group — and that group is a STATIC PRERENDER that must stay CDN-cacheable, so a
   * cookie read there would turn the landing page into a function. `i18n/request.ts` says the whole
   * of that argument. This group is already dynamic (it reads `headers()` two lines down, and every
   * document in it is `private, no-store` or a credential screen), so reading the reader's cookie
   * costs it nothing that was not already spent.
   *
   * The cookie comes out of `headers()` rather than `cookies()` because the header bag is being read
   * anyway for the nonce — one dynamic API instead of two, and one function to reason about when
   * asking why this group cannot be prerendered.
   *
   * ABSENT COOKIE ⇒ ENGLISH, and there is deliberately no `Accept-Language` negotiation. A browser
   * set to German is not a statement about what language somebody wants their MAIL CLIENT in, and
   * silently switching an existing account's interface on the strength of a header nobody set for
   * this purpose is the kind of helpfulness that reads as a bug. The account preference is the
   * authority (adopted by `AppShell` the moment `GET /consent` lands) and the selector in Settings
   * is how it is set.
   */
  const locale = localeFromCookieHeader(headers().get("cookie")) ?? DEFAULT_LOCALE;
  const messages = await loadCatalog(locale);
  /*
   * THE CSP NONCE for the one inline script this group writes by hand.
   *
   * `middleware.ts` mints it, puts it on the response's `Content-Security-Policy`, on the
   * REQUEST's (so Next stamps its own RSC bootstrap scripts with it), and on `x-nonce` —
   * which is this. Next has no way to reach a hand-written `<script>` tag, so the theme
   * boot has to carry it explicitly or first paint under the strict policy is a blocked
   * script and a flash of the wrong theme.
   *
   * Reading `headers()` opts this whole group into DYNAMIC rendering. That is the intended
   * trade and not a side effect: everything under `(product)` is either the mail client
   * (already dynamic, already `private, no-store`) or a credential screen, and none of the
   * three was ever something a CDN should be handing out from a shared cache. The
   * marketing group is untouched and stays a static prerender — which is exactly why it
   * cannot have a nonce, and why `app/security-headers.ts` splits the policy by surface.
   *
   * `?? undefined`: on a request middleware did not mark (a direct `/login` hit in `pnpm
   * dev`, where the header is absent) the attribute is simply omitted and the baseline
   * policy's `'unsafe-inline'` covers the script. It never renders `nonce=""`, which would
   * match nothing.
   */
  const nonce = headers().get("x-nonce") ?? undefined;
  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="mo-canvas app-body">
        <LocaleShell initialLocale={locale} initialMessages={messages}>
          <Providers nonce={nonce}>{children}</Providers>
        </LocaleShell>
      </body>
    </html>
  );
}
