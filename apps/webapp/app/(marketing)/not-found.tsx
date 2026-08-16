import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { DotLabel, Wordmark } from "./components/Wordmark";

/**
 * ── THE PAGE A MISTYPED ADDRESS LANDS ON ────────────────────────────────────────────────
 *
 * Rendered by the `[...missing]` catch-all's `notFound()` (see that file for why the pair
 * exists instead of a root `app/not-found.tsx`), inside the marketing root layout — so it
 * carries the wordmark, both themes' tokens and the `.btn` capsule without importing any of
 * the landing's interactive sections. Deliberately no `Nav` and no `Footer`: those carry
 * session-presence logic and a page whose whole job is "you are still on ohmail, here is the
 * way back" needs neither.
 *
 * The way back goes to `/`, which re-decides for the visitor: a stranger gets the landing,
 * a session gets the app (`session-gate.ts`).
 */
export default async function NotFound() {
  const t = await getTranslations("notFound");
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
