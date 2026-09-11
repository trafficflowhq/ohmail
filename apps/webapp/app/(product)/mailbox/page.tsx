import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE } from "../../shell/locale";
import { CloudShell } from "./CloudShell";
import { isDemoBuild, isDemoRequested, type SearchParamsLike } from "../../demo-mode";

/**
 * The mail client. Reached ONLY as `/` — `middleware.ts` rewrites the root here when the gate answers `app` or
 * `demo`, and 308s a direct request for this path back to `/`, so the product has exactly one public URL. `?demo=1`
 * boots the shell on the FixturesAdapter; with an API base it runs on the HttpAdapter.
 */

/**
 * What is decided HERE is only a FLOOR, deliberately re-decided: `EngineProvider` asks the same question a third time
 * on the client, from `window.location.search`, and may only turn the demo ON, never off — `app/demo-mode.ts` says
 * why (a repeated `demo` parameter arrives as an ARRAY, and a prerender bakes `searchParams = {}` into the emitted
 * HTML, so the runtime query never reaches this function). The honest gate at the bottom is a FALLBACK no request
 * reaches through the front door; it stays because the alternative, if the middleware were ever configured away, is
 * an app shell wired to nothing.
 */
export default async function Page({
  searchParams,
}: {
  searchParams?: SearchParamsLike;
}) {
  const serverDemo = isDemoBuild(process.env) || isDemoRequested(searchParams);
  const apiConfigured = Boolean(process.env.NEXT_PUBLIC_API_BASE);

  // `CloudShell` is `AppShell` plus the one thing the shared shell may not import: how this
  // deployment asks the API whose mailbox it is holding. See its header — the account id
  // names the persistent mirror, and the shell refuses to render one without it.
  if (serverDemo || apiConfigured) return <CloudShell demo={serverDemo} />;

  /* English explicitly — the request config resolves `requestLocale` since the bilingual
     marketing slice, and no layout pins one for this route. Same string as before. */
  const t = await getTranslations({ locale: DEFAULT_LOCALE, namespace: "gate" });
  return (
    <div className="gate">
      <div className="gate-card">
        {/* oh | mail, split so `.gate-card .wordmark em` can carry accent-ink; the
            rendered text is pinned by a suite. */}
        <span className="wordmark">
          <b>
            <em>oh</em>mail
          </b>
        </span>
        <h1>{t("lede")}</h1>
        <p>{t("body")}</p>
        <div className="gate-actions">
          <Link className="btn primary" href="/?demo=1">
            {t("openDemo")}
          </Link>
          <Link className="btn" href="/login">
            {t("signIn")}
          </Link>
        </div>
      </div>
      <p className="gate-foot">{t("footer")}</p>
    </div>
  );
}
