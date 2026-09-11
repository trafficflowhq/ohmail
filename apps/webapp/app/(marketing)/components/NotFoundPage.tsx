import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { AppLocale } from "../../shell/locale";
import { DotLabel, Wordmark } from "./Wordmark";

/**
 * The page a mistyped address lands on, in one locale. The composition lives here because TWO
 * boundaries mount it — `(marketing)/not-found.tsx` and `(marketing-de)/not-found.tsx` — and
 * `(marketing-de)` contributes routing and nothing else. The German boundary exists because a
 * `not-found.tsx` only catches `notFound()` thrown inside its own root layout's tree; until the
 * self-host build started refusing `/de` nothing in that group ever threw, and a refused `/de`
 * answered with Next's unbranded page while `/privacy` got the branded card (review caught it,
 * measurement agreed). Deliberately no `Nav` and no `Footer` — those carry session-presence logic.
 * The way back goes to `/`, which re-decides for the visitor on every deployment.
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
