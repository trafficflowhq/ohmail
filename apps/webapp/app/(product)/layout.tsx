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
 * The other root layout of the single-origin app — see `(marketing)/layout.tsx` for why there are
 * two. Everything under `(product)` renders inside this <html>: `/login`, `/join`, and
 * `mailbox/page.tsx`, which is what a signed-in `/` becomes after `middleware.ts` rewrites it.
 * `app.css` is linked HERE and only here, so the marketing page never carries it. It stays at
 * `app/app.css` rather than moving in beside this file because `apps/desktop` imports it verbatim
 * (`src/main.tsx`) and `scripts/publish-desktop.mjs` copies it by path into the public mirror — the
 * route files moved into this group, the shared shell did not.
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

/* Unfurl cards and search indexing are two different decisions. `noindex` keeps the app shell out
   of search results — under one origin the only thing that does: `/` serves the marketing page to a
   crawler (never signed in, so it gets the indexable metadata) and this shell to a session. A paste
   into Slack or a mail thread is anonymous too and gets the landing's 1200×630 card. So: a
   `summary` card, not `summary_large_image` — the landing owns the big og.png because the landing is
   the thing being sold; this is the app you already decided to use, and the honest card is the
   "oh." tile at icon size plus the name and one line. Lifted out of the return so the self-host
   arm can omit the pair whole — see `generateMetadata`. The URLs stay relative; `metadataBase`
   resolves them, and the build with no `metadataBase` has nothing to resolve. */
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

  /* A self-hosted install has no unfurl card, and must not borrow ours. The `openGraph`/`twitter`
   * URLs are relative and `metadataBase` (pinned to `https://ohmail.app`) turns them absolute, so an
   * operator's own sign-in page shipped `og:url` naming OUR address and images pointing at OUR
   * server — measured on a built self-host bundle. The card claims our address for a server somebody
   * else runs, and every unfurl fetches an image FROM US: a live dependency on our origin inside an
   * install whose whole point is not having one, and a request that tells us the link was shared.
   * `metadataBase` cannot simply be corrected — the web container is not told its own public origin.
   * So the self-host build emits no card at all: the shell is already `noindex`, and a generic
   * unfurl is the honest result for a private mail server. `metadataBase` goes with it.
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
   * The locale, resolved here rather than in `i18n/request.ts`: that config is shared with the
   * `(marketing)` group, a static prerender that must stay CDN-cacheable — a cookie read there
   * would turn the landing into a function. This group is already dynamic (it reads `headers()` for
   * the nonce), so the cookie comes out of that same header bag — one dynamic API instead of two.
   * Absent cookie ⇒ English, and deliberately no `Accept-Language` negotiation: a browser set to
   * German is not a statement about what language somebody wants their mail client in. The account
   * preference is the authority (adopted by `AppShell` when `GET /consent` lands) and the Settings
   * selector is how it is set.
   */
  const locale = localeFromCookieHeader(headers().get("cookie")) ?? DEFAULT_LOCALE;
  const messages = await loadCatalog(locale);
  /*
   * The CSP nonce for the one inline script this group writes by hand. `middleware.ts` mints it, puts it on the
   * response's CSP, the request's (so Next stamps its own RSC bootstrap scripts) and on `x-nonce` — which is this;
   * Next cannot reach a hand-written `<script>`, so the theme boot carries it explicitly or first paint is a blocked
   * script and a flash of the wrong theme. Reading `headers()` opts the whole group into dynamic rendering — the
   * intended trade: everything under `(product)` is the mail client or a credential screen, never CDN material; the
   * marketing group stays a static prerender, which is why it cannot have a nonce and why `app/security-headers.ts`
   * splits the policy by surface. `?? undefined`: on a request middleware did not mark, the attribute is omitted and
   * the baseline `'unsafe-inline'` covers the script — never `nonce=""`, which would match nothing.
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
