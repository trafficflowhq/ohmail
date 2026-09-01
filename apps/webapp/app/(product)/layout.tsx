import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { LocaleShell } from "./LocaleShell";
import { Providers } from "./providers";
import { SELF_HOST_BUILD } from "../self-host-marketing";
import { DEFAULT_LOCALE, localeFromCookieHeader } from "../shell/locale";
import { loadCatalog } from "../../i18n/catalog";
import "../app.css";
/* AFTER app.css, so the Zero layout's overrides sit later in the cascade than the
   classic narrow blocks they re-arrange (specificity already favors them; order
   keeps it unambiguous). Classic is untouched by construction — every selector in
   the file requires [data-layout="zero"] (test/zero-layout-purity.test.ts). */
import "../zero-layout.css";

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

/** The `t` these two need — `getTranslations`' return, narrowed to the one call shape used. */
type Translate = (key: string) => string;

/* Unfurl cards and search indexing are two different decisions, and this file used to make
   only the second one. `noindex` keeps the app shell out of search results — and under one
   origin that is now the only thing that does. `/` is a SINGLE URL serving the marketing page
   to a crawler (which is never signed in, so it always gets `(marketing)`'s indexable
   metadata) and this shell to a session; whichever one rendered is what the <head> describes.
   It says nothing about what happens when somebody pastes https://ohmail.app into Slack,
   iMessage or a mail thread — that paste is anonymous too, and gets the landing's 1200×630 card.

   So: a `summary` card, not `summary_large_image`. The landing owns the 1200×630 og.png with
   the headline in it, because the landing is the thing being sold. This is the app you already
   decided to use — the honest card is the "oh." tile at icon size, the same mark that sits in
   the dock and the browser tab, plus the name and one line of what it is. Anything wider would
   be borrowing marketing weight the shell has not earned.

   Lifted out of the return so the self-host arm can omit the pair WHOLE rather than blank each
   field — see `generateMetadata`. The URLs stay relative; `metadataBase` resolves them, and on
   the build that has no `metadataBase` there is nothing here to resolve. */
const OPEN_GRAPH = (t: Translate): Metadata["openGraph"] => ({
  title: t("title"),
  description: t("description"),
  url: "/",
  siteName: "ohmail",
  type: "website",
  images: [{ url: "/icon-512.png", width: 512, height: 512, alt: t("ogAlt") }],
});

const TWITTER_CARD = (t: Translate): Metadata["twitter"] => ({
  card: "summary",
  title: t("title"),
  description: t("description"),
  images: ["/icon-512.png"],
});

export async function generateMetadata(): Promise<Metadata> {
  /* The app shell's head is English, as it has always been: `generateMetadata` runs
     independently of the layout body below, so it cannot use the cookie locale that body
     resolves, and an implicit lookup would fall through to the request config's `headers()`
     read for the same answer. Naming it makes today's behaviour the stated one. */
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: "meta" });

  /* A SELF-HOSTED INSTALL HAS NO UNFURL CARD, AND MUST NOT BORROW OURS.
   *
   * The `openGraph`/`twitter` URLs below are written RELATIVE — `/`, `/icon-512.png` — and
   * `metadataBase` is what turns them absolute. Pinned to `https://ohmail.app`, an operator's
   * own sign-in page therefore shipped `og:url` naming OUR address and `og:image` /
   * `twitter:image` pointing at OUR server. Measured on a built self-host bundle.
   *
   * Two things wrong with that, and the second is the one that matters. The card claims the
   * hosted service's address for a server somebody else runs; and every client that unfurls a
   * link to their install fetches an image FROM US — a live dependency on our origin inside an
   * install whose whole point is not having one, and a request that tells us the link was
   * shared. `metadataBase` cannot simply be corrected here because the web container is not
   * told its own public origin (the compose passes it only the API's in-network name).
   *
   * So the self-host build emits no card at all. Nothing is lost: this shell is already
   * `noindex, nofollow`, a private mail server is not a page anyone means to preview, and a
   * generic unfurl is the honest result for one. `metadataBase` goes with it — with no
   * relative metadata URL left to resolve, it has nothing to do but name the wrong origin.
   */
  const card: Metadata = SELF_HOST_BUILD ? {} : {
    metadataBase: new URL("https://ohmail.app"),
    openGraph: OPEN_GRAPH(t),
    twitter: TWITTER_CARD(t),
  };

  return {
    ...card,
    title: t("title"),
    description: t("description"),
    icons: ICONS,
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
