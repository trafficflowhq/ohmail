import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE } from "../app/shell/locale";
import { loadCatalog } from "./catalog";

/**
 * NO LOCALE ROUTING, AND A DELIBERATE SPLIT DOWN THE MIDDLE OF THE ORIGIN.
 *
 * `ohmail.app` serves two route groups out of one deployment (see `app/(marketing)/layout.tsx`),
 * and they are NOT the same kind of document:
 *
 *  · `(marketing)` is a STATIC PRERENDER and must stay CDN-cacheable — `middleware.ts` says so in
 *    as many words ("the anonymous `/` is a prerendered marketing page and must stay
 *    CDN-cacheable"), and that is most of why the session gate refuses to fetch anything without a
 *    cookie. Reading a cookie in THIS function is what would break it: `cookies()` opts the caller
 *    into dynamic rendering, so a per-reader locale here would turn the landing page, `/privacy`,
 *    `/imprint` and `/subprocessors` into functions and give one URL two bodies with no `hreflang`
 *    and no separate path to point a crawler at. That is an SEO decision, not an i18n one, and it
 *    is not this slice's to make.
 *
 *  · `(product)` is ALREADY dynamic — its layout reads `headers()` for the CSP nonce — and every
 *    document in it is `private, no-store` or a credential screen. Nothing there was ever cacheable,
 *    so resolving a per-reader locale costs it nothing.
 *
 * So this config stays what it was: the DEFAULT, English, for anything that resolves its messages
 * through next-intl's server pipeline — which after this slice is exactly the marketing group.
 * `(product)/layout.tsx` resolves its own locale from the cookie and passes `locale` and `messages`
 * to `NextIntlClientProvider` explicitly. That is not a workaround: a route group whose caching
 * contract differs is a route group whose locale negotiation differs, and putting the choice in the
 * layout is what makes the difference visible in the file that owns it.
 *
 * The marketing site is therefore English-only for now, and the German catalogue for its namespaces
 * is nevertheless complete (`de.json` is held at full key parity with `en.json`), so turning it on
 * is a locale-routing slice and not a translation one.
 */
export const LOCALE = DEFAULT_LOCALE;

export default getRequestConfig(async () => ({
  locale: LOCALE,
  messages: await loadCatalog(LOCALE),
}));
