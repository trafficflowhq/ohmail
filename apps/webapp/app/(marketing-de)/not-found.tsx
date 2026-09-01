import type { AppLocale } from "../shell/locale";
import { NotFoundPage } from "../(marketing)/components/NotFoundPage";

/**
 * ── THE GERMAN 404 BOUNDARY ─────────────────────────────────────────────────────────────
 *
 * A `not-found.tsx` only catches `notFound()` raised inside its OWN root layout's tree, so the
 * sibling boundary in `(marketing)` cannot serve this group. Until the self-host build began
 * refusing `/de`, nothing here ever raised one and the absence showed on no deployment;
 * measured once it did, a refused `/de` answered with Next's own unbranded 404 while `/privacy`
 * answered with the branded card.
 *
 * Routing only, as this group's layout requires: the composition, the copy and the stylesheet
 * are all `(marketing)`'s. `messages/de.json` already carried the `notFound` namespace in full.
 */
const LOCALE = "de" satisfies AppLocale;

export default function GermanNotFound() {
  return <NotFoundPage locale={LOCALE} />;
}
