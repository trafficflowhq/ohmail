import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { AppLocale } from "../../shell/locale";
import { DotLabel, Wordmark } from "./Wordmark";

/**
 * ── THE PAGE A MISTYPED ADDRESS LANDS ON, IN ONE LOCALE ─────────────────────────────────
 *
 * The composition lives here rather than in `not-found.tsx` because there are now TWO
 * boundaries mounting it — `(marketing)/not-found.tsx` and `(marketing-de)/not-found.tsx` —
 * and `(marketing-de)`'s own rule is that it contributes routing and nothing else: every
 * section this app renders in German comes from `(marketing)`. One composition, two mounts,
 * exactly like the landing.
 *
 * WHY THE GERMAN BOUNDARY EXISTS AT ALL. A `not-found.tsx` only catches `notFound()` thrown
 * inside its OWN root layout's tree, so `(marketing)`'s boundary cannot serve `(marketing-de)`.
 * Until the self-host build started refusing `/de` (`app/self-host-marketing.ts`) nothing in
 * that group ever threw, so the gap was invisible; a review caught it, and the measurement
 * agreed — a refused `/de` answered with Next's own unbranded "This page could not be found"
 * while a refused `/privacy` got the branded card. Two boundaries, one composition, no
 * unbranded page on any origin.
 *
 * Deliberately no `Nav` and no `Footer`: those carry session-presence logic, and a page whose
 * whole job is "you are still here, this is the way back" needs neither.
 *
 * The way back goes to `/`, which re-decides for the visitor: on the hosted service a stranger
 * gets the landing and a session gets the app (`session-gate.ts`); on a self-hosted install it
 * is that server's sign-in door. Right on every deployment without knowing which one it is.
 */
export async function NotFoundPage({ locale }: { locale: AppLocale }) {
  /* The locale is PASSED, never resolved: this renders inside a root layout that pinned one as
     a literal, and an implicit lookup would fall through to the request config's `headers()`
     read — the thing both marketing trees exist to avoid. */
  const t = await getTranslations({ locale, namespace: "notFound" });
  return (
    <main className="nf">
      <Link href="/" className="nf-brand">
        <Wordmark />
      </Link>
      <p className="nf-code" aria-hidden="true">
        404
      </p>
      <h1 className="nf-title">{t("title")}</h1>
      <p className="nf-note">{t("note")}</p>
      <Link href="/" className="btn primary nf-home">
        <DotLabel text={t("home")} />
      </Link>
    </main>
  );
}
