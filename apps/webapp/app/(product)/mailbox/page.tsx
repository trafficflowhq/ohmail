import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DEFAULT_LOCALE } from "../../shell/locale";
import { CloudShell } from "./CloudShell";
import { isDemoBuild, isDemoRequested, type SearchParamsLike } from "../../demo-mode";

/**
 * The mail client. Reached ONLY as `/` — `middleware.ts` rewrites the root here when the
 * session gate answers `app` or `demo`, and answers a direct request for this path with a
 * 308 back to `/`. The browser's address bar therefore never shows `/mailbox`, and the
 * product has exactly one public URL.
 *
 * `?demo=1` (or NEXT_PUBLIC_DEMO at build time) boots the client shell on the
 * FixturesAdapter; with an API base configured the same shell runs on the HttpAdapter.
 *
 * What is decided HERE is only a FLOOR, and it is deliberately re-decided rather than
 * trusted from the middleware. `EngineProvider` asks the same question a third time on
 * the client, from `window.location.search`, before it constructs anything — and may only
 * turn the demo ON, never off. `app/demo-mode.ts` explains why a server-side answer alone
 * is unsafe: a repeated `demo` parameter arrives as an ARRAY (so `=== "1"` was false for
 * `/?demo=1&demo=0`, silently yielding the live client), and any prerender of this route
 * bakes `searchParams = {}` into the one emitted HTML, so the runtime query never reaches
 * this function at all.
 *
 * The honest gate at the bottom is now a FALLBACK rather than a route anyone arrives at:
 * middleware only sends a request here for the demo or for a VALIDATED full session, and
 * validating a session requires `TF_API_ORIGIN`, which is also what sets
 * `NEXT_PUBLIC_API_BASE`. "Neither demo nor API" is therefore unreachable through the
 * front door. It stays because the alternative — if the middleware were ever configured
 * away — is an app shell wired to nothing.
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
