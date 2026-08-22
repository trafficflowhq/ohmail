import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, normalizeLocale } from "../app/shell/locale";
import { loadCatalog } from "./catalog";

/**
 * THE LOCALE THE SERVER RENDER USES — TAKEN FROM THE LAYOUT, NEVER FROM THE REQUEST.
 *
 * `ohmail.app` serves three root layouts out of one deployment, and they are NOT the same kind
 * of document:
 *
 *  · `(marketing)` and `(marketing-de)` are STATIC PRERENDERS and must stay CDN-cacheable —
 *    `middleware.ts` says so in as many words ("the anonymous `/` is a prerendered marketing
 *    page and must stay CDN-cacheable"), and that is most of why the session gate refuses to
 *    fetch anything without a cookie.
 *  · `(product)` is ALREADY dynamic — its layout reads `headers()` for the CSP nonce — and
 *    every document in it is `private, no-store` or a credential screen.
 *
 * `requestLocale` resolves in two steps, and only the FIRST of them is used here in practice:
 * the value a layout pinned with `setRequestLocale`, and — failing that — an
 * `X-NEXT-INTL-LOCALE` header, read with `headers()`. The header read is the dangerous half:
 * `headers()` opts the caller into DYNAMIC rendering, so a marketing route that reached it
 * would stop being a prerender, lose its cache, and give one URL two bodies with no `hreflang`
 * and no separate address to point a crawler at.
 *
 * Both marketing root layouts therefore call `setRequestLocale` with their own literal before
 * anything under them renders, which is what keeps `/` and `/de` static. Nothing sets that
 * header — this deployment runs no next-intl routing middleware — so on `(product)` the
 * fallback below answers, and the product's server-rendered metadata stays English exactly as
 * it was; `(product)/layout.tsx` resolves the reader's own locale from the cookie and hands
 * `locale` and `messages` to `NextIntlClientProvider` explicitly, which is what translates the
 * app itself.
 *
 * `normalizeLocale` rather than a raw pass-through: it reduces to the closed set in
 * `app/shell/locale.ts` and answers `null` for anything else, so a value that is not a locale
 * this build ships renders English instead of `notFound()` — which is what next-intl does with
 * a config that returns no locale at all.
 */

export default getRequestConfig(async ({ requestLocale }) => {
  const locale = normalizeLocale(await requestLocale) ?? DEFAULT_LOCALE;
  return { locale, messages: await loadCatalog(locale) };
});
