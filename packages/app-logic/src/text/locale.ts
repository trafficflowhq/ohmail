/**
 * THE CLOSED SET, and it is closed in four places that must agree: here, the CHECK on
 * `account_settings.locale` (mail 0053), the wire validation in `PATCH /consent/settings`, and
 * the selector in Settings → General. `test/locale-catalog.test.ts` holds this array against the
 * catalogue files that exist on disk, so adding a member without adding `messages/<locale>.json`
 * fails rather than rendering raw keys.
 */
export const LOCALES = ["en", "de"] as const;

export type AppLocale = (typeof LOCALES)[number];

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Reduce anything to a member of {@link LOCALES}, or `null` for "this says nothing". The primary
 * subtag only: `de-CH`, `de-DE` and `de` are one catalogue here, and a Swiss reader asking for
 * `de-CH` must not fall through to English on a tag mismatch; case is folded because
 * `Accept-Language` and a hand-set cookie arrive in either. `null` rather than `DEFAULT_LOCALE` is
 * the whole point of the return type: a caller must distinguish "nobody has said" (keep looking at
 * the next source) from "they said English" — the account read in `consent-state.ts` depends on
 * exactly that difference.
 */
export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isAppLocale(primary) ? primary : null;
}
