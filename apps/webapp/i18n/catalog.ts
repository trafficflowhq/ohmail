/**
 * ONE DEFINITION OF "the messages for this locale", used by the server render and by the client
 * switch — so the fallback rule cannot be implemented twice and differently.
 *
 * ── THE RULE: `de` FILLS OVER `en`, IT DOES NOT REPLACE IT ─────────────────────────────────────
 *
 * A key present in `en.json` and absent from `de.json` must render the ENGLISH sentence. next-intl's
 * own behaviour for a missing key is `getMessageFallback`, whose default returns the dotted KEY —
 * so an incomplete catalogue puts `screener.toastFiled` on somebody's screen where a sentence
 * belongs. That is not a theoretical risk: it is what every future slice that adds an English key
 * and forgets the German one would ship, and it would ship silently.
 *
 * Two things stop it, in this order:
 *
 *  1. `test/locale-catalog.test.ts` asserts the two files have IDENTICAL key sets and LISTS the
 *     offenders. That is the loud half, and it is the one that keeps the translation honest.
 *  2. this merge is the quiet half — the runtime guarantee that even a catalogue which somehow got
 *     past (1) degrades to English rather than to a key name. Both are wanted: a guard can be
 *     skipped in a hurry, and a raw key on screen is worse than an English sentence.
 *
 * The merge is DEEP, because the catalogue nests (`screener.empty.waiting.title`,
 * `settings.channel.people.label`). A shallow spread would take German's whole `screener` object
 * and drop every English leaf under it that German had not filled — the exact failure the merge
 * exists to prevent, one level down.
 *
 * ── AND WHY THIS IS A DYNAMIC IMPORT ───────────────────────────────────────────────────────────
 *
 * `de.json` is the same size as `en.json`. Importing both statically would put ~200 KB of
 * translations in every bundle that touches this module, including for the English reader who is
 * the overwhelming majority. `import()` lets Next split them: an English session fetches `en` only,
 * and `de` arrives on the switch (and on the first paint of a German session, where the server
 * render already resolved it and the payload carries the result).
 */
import { DEFAULT_LOCALE, fillFrom, type AppLocale } from "../app/shell/locale";

/**
 * A catalogue, as the intl packages type one: a recursive tree of strings.
 *
 * Narrower than the `Record<string, unknown>` a JSON import produces, and narrowed HERE rather than
 * cast at each provider — `NextIntlClientProvider`, `IntlProvider` and `getRequestConfig` all take
 * this shape, and three separate casts is three places for the shape to be wrong.
 */
export type Messages = { [key: string]: string | Messages };

/** The English catalogue on its own — the base of every merge and the answer for `en`. */
async function english(): Promise<Messages> {
  return (await import("../messages/en.json")).default as unknown as Messages;
}

/**
 * One loader per non-English locale, written out rather than built from a template literal.
 *
 * `import(\`../messages/${locale}.json\`)` compiles to a webpack CONTEXT over the whole directory:
 * every file in `messages/` becomes a lazy chunk whether or not it is a catalogue, and a stray file
 * dropped there joins the bundle. Naming each import keeps the module graph exactly as wide as
 * {@link LOCALES}, and a member added to that array without an entry here is a type error rather
 * than a runtime miss.
 */
type Overlay = Exclude<AppLocale, typeof DEFAULT_LOCALE>;

const OVERLAYS: Record<Overlay, () => Promise<{ default: unknown }>> = {
  de: () => import("../messages/de.json"),
};

/**
 * The messages to render `locale` with. English is returned as-is (there is nothing to fill from);
 * every other locale is filled over English.
 *
 * A locale whose file cannot be loaded resolves to ENGLISH rather than throwing. A deploy that
 * shipped a `de` preference and no `de.json` — or a chunk that failed to fetch on a flaky
 * connection — must render the app in English, not a blank screen: the preference is a display
 * choice and losing it is not worth a crash.
 */
export async function loadCatalog(locale: AppLocale): Promise<Messages> {
  const base = await english();
  if (locale === DEFAULT_LOCALE) return base;
  try {
    const over = (await OVERLAYS[locale as Overlay]()).default as Messages;
    return fillFrom(base as never, over as never) as Messages;
  } catch {
    return base;
  }
}
