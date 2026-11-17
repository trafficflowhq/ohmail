import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE } from "../shell/locale";
import { NoPageRoute } from "./NoPageRoute";

/**
 * The 404 boundary every build carries. The `[...missing]` catch-all beside it calls `notFound()`
 * for every path no route claims, and this renders the no-page with a real 404 status. It
 * sits in `(product)` because the app has no shared root layout (a top-level `app/not-found.tsx`
 * fails `next build`) and this is the group a self-hosted build always ships. English, like the
 * catch-all's title: the path is unknown, so nothing says which language was wanted.
 */
export default async function NotFound() {
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: "gate" });
  return <NoPageRoute at="missing" words={{ title: t("missingTitle"), note: t("missingNote"), home: t("missingHome") }} />;
}
