/**
 * THE SIZE OF A FILE, SAID ONCE.
 *
 * There were three of these, each private to one component and each claiming to agree with the
 * others: two were 1000-based and `ComposeAttach`'s was 1024-based, so the composer and the
 * reading pane named different sizes for the same file. 1000-based, like the Finder the file is
 * about to land in. One decimal below 100 of a unit, whole above, never a trailing ".0" —
 * "512 B", "748 KB", "2.3 MB", "18.2 MB".
 */

/**
 * The locale is REQUIRED, `formatStorageBytes`'s rule and for its measured reason: a raw number
 * interpolated into a German sentence reads "1.5 GB" where a decimal point is a thousands
 * separator, so the row said fifteen gigabytes. `toLocaleString()` with no argument reads the
 * HOST's locale, so a missing argument is a compile error rather than a silent wrong default.
 * The NUMBER is what the locale decides; the units stay `B`/`KB`/`MB`/`GB` with an ordinary space
 * — the copy law already shipped everywhere else, which `Intl`'s own `style: "unit"` does not
 * speak (it renders "kB" and "Byte", and spaces German gigabytes with U+00A0).
 */
export function formatFileSize(bytes: number, locale: string): string {
  const n = (v: number, decimals: number): string =>
    v.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  if (bytes < 1000) return `${n(bytes, 0)} B`;
  let value = bytes / 1000;
  for (const unit of ["KB", "MB", "GB"]) {
    if (value < 1000 || unit === "GB") {
      return value < 100 ? `${n(value, 1)} ${unit}` : `${n(Math.round(value), 0)} ${unit}`;
    }
    value /= 1000;
  }
  /* unreachable — the GB arm above always returns */
  return `${n(bytes, 0)} B`;
}
