import type { AppLocale } from "../shell/locale";
import { NotFoundPage } from "../(marketing)/components/NotFoundPage";

/**
 * The German 404 boundary. A `not-found.tsx` only catches `notFound()` raised inside its OWN root
 * layout's tree, so the sibling boundary in `(marketing)` cannot serve this group. Until the
 * self-host build began refusing `/de` nothing here ever raised one, so the absence showed on no
 * deployment; measured once it did, a refused `/de` answered with Next's own unbranded 404 while
 * `/privacy` answered with the branded card. Routing only, as this group's layout requires: the
 * composition, copy and stylesheet are all `(marketing)`'s — `messages/de.json` already carried the
 * `notFound` namespace in full.
 */
const LOCALE = "de" satisfies AppLocale;

export default function GermanNotFound() {
  return <NotFoundPage locale={LOCALE} />;
}
