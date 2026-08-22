import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE } from "../../shell/locale";

/**
 * ── THE CATCH-ALL THAT MAKES A BRANDED 404 POSSIBLE AT ALL ──────────────────────────────
 *
 * ohmail.app has TWO root layouts (`(marketing)` and `(product)` — the split is load-bearing,
 * see `(marketing)/layout.tsx`), and Next only renders a root `app/not-found.tsx` inside a
 * root layout this app deliberately does not have. So unknown paths used to fall through to
 * the framework's own unbranded 404: no wordmark, no way back, another product's face on this
 * origin.
 *
 * This segment matches every path no real route claims — a catch-all always loses to a more
 * specific route, so nothing reachable changes — and does exactly one thing: `notFound()`,
 * which renders the sibling `not-found.tsx` boundary WITH a real 404 status. The status is
 * the half a pretty page alone would get wrong: a branded page served with a 200 teaches
 * every crawler and every link checker that garbage paths exist.
 *
 * A structural guard pins the route's shape; that the built app serves it with
 * the status is a `next build` + browser question.
 */

export async function generateMetadata(): Promise<Metadata> {
  /* The locale is passed rather than resolved: `getTranslations()` with no locale reads the
     request config, which since the bilingual slice resolves `requestLocale` — and on a route
     no layout has pinned that means a `headers()` read. This catch-all is English by design
     (its sibling `not-found.tsx` renders inside the English root layout), so it says so. */
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: "notFound" });
  return { title: `${t("title")} · ohmail`, robots: { index: false, follow: false } };
}

export default function MissingPage(): never {
  notFound();
}
