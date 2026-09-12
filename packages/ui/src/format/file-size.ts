/**
 * THE SIZE OF A FILE, SAID ONCE.
 *
 * There were three of these, each private to one component and each claiming to agree with the
 * others: `AttachmentPreview`'s and `AttachmentStrip`'s were 1000-based, `ComposeAttach`'s was
 * 1024-based, so the composer and the reading pane named different sizes for the same file — and
 * a fourth was avoided by leaving the draft-ceiling sentence without a number at all.
 *
 * 1000-based, like the Finder the file is about to land in, which is the one of the two with a
 * reason behind it. One decimal below 100 of a unit, whole above, never a trailing ".0" —
 * "512 B", "748 KB", "2.3 MB", "18.2 MB".
 */

/**
 * The locale is REQUIRED, `formatStorageBytes`'s rule and for its measured reason: a raw number
 * interpolated into a German sentence reads "1.5 GB" where a decimal point is a thousands
 * separator, so the row said fifteen gigabytes. `toLocaleString()` with no argument reads the
 * HOST's locale — a property of the computer, not the language somebody chose in this app — so a
 * missing argument is a compile error rather than a silent wrong default.
 *
 * The NUMBER is what the locale decides; the units stay `B`/`KB`/`MB`/`GB` and the space before
 * them stays an ordinary one. That is the copy law already shipped in every other size in the
 * product, and `Intl`'s own `style: "unit"` does not speak it: it renders "kB" and "Byte", and
 * spaces German gigabytes with U+00A0 while spacing German megabytes with U+0020.
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
