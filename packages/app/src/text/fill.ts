/** A catalogue: a tree of sentences, as one place file or the whole of one language holds it. */
export type Messages = { readonly [key: string]: string | Messages };

/** German fills over English, deep: the one merge both hosts and the reader use. */
export function fillOver(base: Messages, over: Messages): Messages {
  return fillFrom(base, over) as Messages;
}

/**
 * THE FALLBACK MERGE — declared HERE rather than beside the loader, because both hosts need it and only one of them
 * has the loader. Both `apps/webapp/i18n` and `apps/webapp/app/shell` are published (this paragraph once claimed the
 * i18n directory was denied; `scripts/publish-desktop.mjs` maps it, and the claim was stale, not the mapping). The
 * rule lives HERE because both hosts need it and only one of them has the loader: putting it in the shared half keeps
 * ONE definition of "a key German is missing renders the English sentence" instead of two that can drift — and
 * drifting here does not produce a worse sentence, it produces `screener.toastFiled` on somebody's screen, which is
 * the intl library's default fallback for an absent key and the single failure this whole slice is built to prevent.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `over` wins wherever it holds a LEAF; `base` supplies everything else, at every depth. DEEP, because the catalogue
 * nests (`screener.empty.waiting.title`, `settings.channel.people.label`). A shallow spread would take German's whole
 * `screener` object and drop every English leaf under it that German had not filled — the same failure one level down
 * and much harder to see. An EMPTY STRING counts as absent. A placeholder somebody left unfilled must not blank a
 * sentence: the English one is a worse translation and a better product than nothing at all.
 */
function fillFrom(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(over)) {
    const overValue = over[key];
    const baseValue = out[key];
    if (isPlainObject(overValue) && isPlainObject(baseValue)) {
      out[key] = fillFrom(baseValue, overValue);
      continue;
    }
    if (overValue === "" || overValue === undefined || overValue === null) continue;
    out[key] = overValue;
  }
  return out;
}
