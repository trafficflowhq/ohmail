import { DEFAULT_LOCALE } from "../shell/locale";
import { NotFoundPage } from "./components/NotFoundPage";

/**
 * ── THE ENGLISH 404 BOUNDARY ────────────────────────────────────────────────────────────
 *
 * Rendered by the `[...missing]` catch-all's `notFound()` (see that file for why the pair
 * exists instead of a root `app/not-found.tsx`), and — on the self-host build — by the
 * marketing pages' own refusal (`app/self-host-marketing.ts`). The composition is shared with
 * `(marketing-de)/not-found.tsx`; this file is the English MOUNT of it, and the locale is a
 * literal here for the same reason it is in the layout above.
 */
export default function NotFound() {
  return <NotFoundPage locale={DEFAULT_LOCALE} />;
}
