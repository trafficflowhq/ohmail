/**
 * THE LOCALE DIMENSION — the vocabulary two hosts and one non-React surface share.
 *
 * `messages/en.json` was the whole of i18n here: `i18n/request.ts` pinned `LOCALE = "en"` and
 * every `useTranslations` read one catalogue. Shipping German did not need a new accessor — `t()`
 * is unchanged and no key moved — it needed a LOCALE to resolve, in three places that cannot
 * share a React tree:
 *
 *  1. the Next app's `(product)` layout, which renders `NextIntlClientProvider` on the server;
 *  2. `apps/desktop/src/main.tsx`, which wires `IntlProvider` by hand and has no Next at all;
 *  3. modules that are NOT components and therefore cannot call a hook — `format.ts`, which
 *     `screener-state.ts` and `AppShell` import as a plain function library, and the three
 *     reading-pane components whose copy is still a local constant.
 *
 * This file is the part all three can hold: the closed set of locales, how a stored or negotiated
 * string is reduced to one of them, where the local preference is kept, and — for (3) — a
 * TRANSLATOR THAT IS NOT A HOOK. It imports nothing but `next-intl`'s `createTranslator`, which
 * `apps/desktop/vite.config.ts` aliases to the identical `use-intl` function, so it compiles into
 * the desktop bundle exactly as `AppShell` does.
 *
 * It deliberately does NOT import a catalogue. `messages/en.json` is 100 KB; a static import here
 * would put it in the client JS bundle a second time (the web app already ships it through the RSC
 * payload) and would make every consumer of `format.ts` drag it along. The catalogue arrives by
 * INJECTION — {@link setActiveCatalog}, called by whichever host built the provider — and until it
 * does {@link activeTranslator} answers `null` and each caller falls back to its own English
 * constant. That is what keeps a bare component render in a unit test deterministic and
 * English-only without a provider in it.
 */
import { createTranslator } from "next-intl";

/**
 * THE CLOSED SET, and it is closed in four places that must agree: here, the CHECK on
 * `account_settings.locale` (mail 0053), the wire validation in `PATCH /consent/settings`, and
 * the selector in Settings → General. `test/locale-catalog.test.ts` holds this array against the
 * catalogue files that exist on disk, so adding a member without adding `messages/<locale>.json`
 * fails rather than rendering raw keys.
 */
export const LOCALES = ["en", "de"] as const;

export type AppLocale = (typeof LOCALES)[number];

/**
 * ENGLISH IS THE FALLBACK, not merely the default — the distinction matters at two different
 * layers and both are load-bearing:
 *
 *  · nobody has chosen ⇒ English. `account_settings.locale` stores NULL rather than `'en'`, the
 *    same "never store the default" rule `dormancy_days` states one column over.
 *  · a German catalogue is MISSING A KEY ⇒ the English string, never the raw key. That is
 *    `loadCatalog` in `i18n/catalog.ts`, which fills `de` over `en` rather than replacing it.
 */
/* Typed as the LITERAL rather than as `AppLocale`, because consumers subtract it: `catalog.ts`
   builds its overlay map as `Exclude<AppLocale, typeof DEFAULT_LOCALE>`, and with the wider
   annotation that subtraction is `never` and the map compiles to an object with no keys. */
export const DEFAULT_LOCALE = "en" satisfies AppLocale;

/**
 * WHERE THE LOCAL PREFERENCE LIVES, and why there are two of them.
 *
 * `localStorage` is what a STANDALONE install has and all it has: there is no account to store a
 * preference on, so the selector in Settings writes here and the desktop's own `main.tsx` reads it
 * before the first paint — the same shape as `ohmail.theme` beside it.
 *
 * The COOKIE exists for one thing the storage cannot do: `(product)/layout.tsx` renders on the
 * SERVER, and a server has no way to read `localStorage`. Without it the first paint of every
 * navigation would be English and would then flip, which is the flash the whole single-origin
 * gate was built to avoid. Both are written together by {@link rememberLocale} so they cannot
 * disagree; the cookie is host-only and carries no `Domain=`, exactly like the session cookie,
 * because widening it is never worth it for a display preference.
 */
export const LOCALE_STORAGE_KEY = "ohmail.locale";
export const LOCALE_COOKIE = "ohmail.locale";

/** A year. Long enough that a returning reader is not reset to English, short enough to expire. */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Reduce anything to a member of {@link LOCALES}, or `null` for "this says nothing".
 *
 * The PRIMARY SUBTAG only: `de-CH`, `de-DE` and `de` are one catalogue here, and a Swiss reader
 * asking for `de-CH` must not fall through to English on a tag mismatch. Case is folded because
 * `Accept-Language` and a hand-set cookie both arrive in either.
 *
 * `null` rather than `DEFAULT_LOCALE`, and that is the whole point of the return type: a caller
 * has to distinguish "nobody has said" (fall back, keep looking at the next source) from "they
 * said English". The account read in `consent-state.ts` depends on exactly that difference.
 */
export function normalizeLocale(value: string | null | undefined): AppLocale | null {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return isAppLocale(primary) ? primary : null;
}

/** The local preference, or `null` when storage is blocked or nothing has been stored. */
export function readStoredLocale(): AppLocale | null {
  try {
    return normalizeLocale(globalThis.localStorage?.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return null; // private mode, or a webview with storage off — English, and no error to read
  }
}

/**
 * Persist the choice LOCALLY — both mediums, one call, never one without the other.
 *
 * Best-effort by construction: a blocked `localStorage` throws and a document-less environment
 * (the server render, a node test) has no `document`. Neither is an error worth surfacing, because
 * the in-memory locale is already correct — the only cost is that the NEXT load starts in English.
 */
export function rememberLocale(locale: AppLocale): void {
  try {
    globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage blocked — the live locale still applies for this session */
  }
  try {
    if (typeof document !== "undefined") {
      document.cookie =
        `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
    }
  } catch {
    /* no document — the server render reads the cookie it was sent, not one we could write */
  }
}

/** Read the locale cookie out of a `Cookie:` header value. Used by the server render. */
export function localeFromCookieHeader(header: string | null | undefined): AppLocale | null {
  if (typeof header !== "string" || header === "") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
    return normalizeLocale(decodeURIComponent(part.slice(eq + 1).trim()));
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE NON-HOOK TRANSLATOR — for the surfaces that are not components.

   `format.ts` is a function library: `screener-state.ts` calls `PLACE_LABEL[dest]` from a reducer
   and `AppShell` calls `resurfaceLabel(when)` inside a callback. Neither can call
   `useTranslations`, and the words they produce — "Ohbox", "Reads", "Fri 09:00", "Tue 5 Aug 2026"
   — are on screen. So they need a translator that is a plain function.

   ── WHY A MODULE REGISTER AND NOT A PROP ────────────────────────────────────────────────────

   Threading a catalogue into `placeLabel` means changing the signature of ten call sites across
   eight files, three of which are not components at all, plus the reducer in `screener-state.ts`
   that has no React context to read from. The register is one seam instead of ten, and it is the
   seam the hosts already own: whoever builds the intl provider calls {@link setActiveCatalog} in
   the same place, with the same messages.

   ── WHAT THE REGISTER MUST NOT BECOME ───────────────────────────────────────────────────────

   A SECOND i18n system. It reads the SAME `messages/<locale>.json` the hooks read, through the
   same ICU implementation, resolved for the same locale — `createTranslator` is what
   `useTranslations` is built on. Nothing may be declared here that is not a key in that
   catalogue, and `test/locale-shim-parity.test.ts` asserts every English constant that falls back
   through this path has an identical key set in the catalogue.

   ── AND WHY `null` IS THE RESTING ANSWER ────────────────────────────────────────────────────

   Absent means "no host has set a catalogue", which is exactly the state of a unit test that
   renders one component with no provider — 40-odd of them in `apps/webapp/test`. Those tests
   assert English, and they must keep passing without a provider bolted onto each one. So the
   resting answer is `null` and every caller falls back to its own English constant, which is the
   same string the catalogue holds (asserted, see above). It is never a raw key and never empty.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** The shape a caller gets back: ICU-formatting, namespace-scoped, values by name. */
export type NamespaceTranslator = (key: string, values?: Record<string, unknown>) => string;

type Catalog = Record<string, unknown>;

let activeLocale: AppLocale = DEFAULT_LOCALE;
let activeCatalog: Catalog | null = null;
/** One translator per namespace per catalogue — `createTranslator` compiles ICU, so it is cached. */
let translators = new Map<string, NamespaceTranslator>();

/**
 * Hand the non-hook surfaces the catalogue the provider is rendering with.
 *
 * Called by BOTH hosts at the same point they build their intl provider — `LocaleShell` on the web,
 * `main.tsx` on the desktop — and called for ENGLISH too, not only for a second locale. Running the
 * English case through the same path is what keeps it exercised: a register that were only touched
 * when somebody switched to German would be untested on every English session, which is all of
 * them today.
 *
 * Synchronous, and it has to be: the host calls it during its own render, before children render,
 * so the first paint after a switch already carries the new vocabulary. `null` clears it, which is
 * what a test that wants the English constants back asks for.
 */
export function setActiveCatalog(locale: AppLocale, messages: Catalog | null): void {
  activeLocale = locale;
  activeCatalog = messages;
  translators = new Map();
}

/** The locale the register is holding — what `format.ts` passes to `Intl`. */
export function activeFormatLocale(): AppLocale {
  return activeLocale;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE ZONE DIMENSION — one seam, beside the locale one, for the same reason.

   The product showed TWO clocks at once. `AboutSection`, `MailboxSection` and `BillingSection`
   render account dates through `toLocaleDateString`, which reads the reader's own zone; every MAIL
   stamp — the row time, the hover title, the resurface label, the Screener's derived rows — was
   formatted with `timeZone: "UTC"`. A reader in Zurich saw a message that arrived at 16:32 stamped
   "14:32", two hours behind the account dates on the same screen.

   Storage does not move: every instant on the wire and in the mirror is UTC, and `bubbleUpAt` is
   still a UTC instant the worker compares against `now`. What this seam decides is only the zone an
   instant is READ in — and the answer is the reader's, everywhere, once.

   ── WHY A MODULE-LEVEL RESOLUTION AND NOT A HOOK ────────────────────────────────────────────

   Exactly the argument {@link activeFormatLocale} is here for: `format.ts` is a function library
   that `screener-state.ts` calls from inside a reducer and `AppShell` from inside a toast callback,
   and `messageDisplayTime` is called once per visible row from a selector in another package.
   Threading a zone through all of that as a prop is ten signatures; this is one.

   ── AND WHY IT RESOLVES ITSELF RATHER THAN WAITING TO BE TOLD ───────────────────────────────

   The locale register rests at `null` and each host injects, because a locale is a CHOICE. A zone
   is not: it is a property of the machine the reader is looking at, and `Intl.DateTimeFormat()
   .resolvedOptions().timeZone` already knows it in the browser, in the desktop webview and in Node.
   Resting on a host injection would mean a host that forgets silently renders UTC again — which is
   the bug. So the resting answer is the platform's own zone, resolved once (constructing a
   `DateTimeFormat` is the expensive part) and cached until something injects.

   {@link setActiveFormatZone} is that injection. It exists for tests — a stamp assertion must not
   depend on the TZ of the machine running the suite, and the DST guards need a zone that HAS a DST
   rule — and it is the hook a future "show times in the mailbox's zone" preference would use.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** What a platform that cannot name its own zone falls back to. Never reached in a browser. */
export const FALLBACK_FORMAT_ZONE = "UTC";

let activeZone: string | null = null;

/** The IANA zone every mail time renders in — the reader's own, resolved once. */
export function activeFormatZone(): string {
  if (activeZone === null) {
    try {
      activeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_FORMAT_ZONE;
    } catch {
      /* No ICU zone data at all. UTC is wrong for most readers and right for nobody, but it is a
         clock rather than a crash, and every stamp in the product used to be exactly this. */
      activeZone = FALLBACK_FORMAT_ZONE;
    }
  }
  return activeZone;
}

/**
 * Render for a named zone instead of the platform's. `null` drops back to the platform.
 *
 * Synchronous and immediate, like {@link setActiveCatalog}: the formatter caches in `format.ts` and
 * `selectors.ts` are keyed by zone, so a switch is visible on the next call rather than on the next
 * reload.
 */
export function setActiveFormatZone(zone: string | null): void {
  activeZone = zone;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE FALLBACK MERGE — declared HERE rather than beside the loader, because both hosts need it and
   only one of them has the loader.

   `apps/webapp/i18n` is DENIED by `scripts/publish-desktop.mjs`, so `i18n/catalog.ts` does not exist
   in the public mirror a released desktop binary is built from. `apps/webapp/app/shell` IS published.
   Putting the rule in the shared half keeps ONE definition of "a key German is missing renders the
   English sentence" instead of two that can drift — and drifting here does not produce a worse
   sentence, it produces `screener.toastFiled` on somebody's screen, which is the intl library's
   default fallback for an absent key and the single failure this whole slice is built to prevent.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `over` wins wherever it holds a LEAF; `base` supplies everything else, at every depth.
 *
 * DEEP, because the catalogue nests (`screener.empty.waiting.title`,
 * `settings.channel.people.label`). A shallow spread would take German's whole `screener` object and
 * drop every English leaf under it that German had not filled — the same failure one level down and
 * much harder to see.
 *
 * An EMPTY STRING counts as absent. A placeholder somebody left unfilled must not blank a sentence:
 * the English one is a worse translation and a better product than nothing at all.
 */
export function fillFrom(
  base: Record<string, unknown>, over: Record<string, unknown>,
): Record<string, unknown> {
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

/**
 * A translator for one namespace, or `null` when no catalogue has been set OR the catalogue has no
 * such namespace. Both answers mean the same thing to a caller — use your English constant — and
 * collapsing them is safe here precisely because they are the same fallback.
 */
export function activeTranslator(namespace: string): NamespaceTranslator | null {
  if (activeCatalog === null) return null;
  const cached = translators.get(namespace);
  if (cached) return cached;
  if (typeof activeCatalog[namespace] !== "object" || activeCatalog[namespace] === null) return null;
  const t = createTranslator({
    locale: activeLocale,
    messages: activeCatalog as Parameters<typeof createTranslator>[0]["messages"],
    namespace,
    /* A KEY THE CATALOGUE DOES NOT HOLD FALLS BACK, IT DOES NOT THROW OR PRINT ITSELF.
       next-intl's default `onError` logs and its default `getMessageFallback` returns the dotted
       KEY as the rendered string — which is the one outcome this whole slice exists to prevent, and
       it would appear on screen rather than in a test. `de.json` is held at full key parity with
       `en.json` by `test/locale-catalog.test.ts` and filled from English by `loadCatalog`, so this
       arm is unreachable through either host; it is here for the third case neither covers — a
       catalogue handed in by some future caller that is missing a key the shim names. Returning the
       empty string keeps a sentence short rather than making it a bug report. */
    onError: () => {},
    getMessageFallback: () => "",
  }) as unknown as NamespaceTranslator;
  translators.set(namespace, t);
  return t;
}

/**
 * TURN A TABLE OF ENGLISH SENTENCES INTO A LIVE VIEW OF ONE CATALOGUE NAMESPACE.
 *
 * The three reading-pane components each hold their copy as one object and read it from forty-odd
 * places, including from module-level helper functions that are not components at all (`Tile`,
 * `ListState`, `renderContent`). This returns an object of the SAME SHAPE whose string members are
 * GETTERS over the active catalogue and whose function members format the same ICU message — so
 * every one of those call sites is unchanged and every one of them is now translated.
 *
 * ── GETTERS, WHICH IS THE ONE UNUSUAL THING HERE AND THE REASON THE MIGRATION IS SAFE ──────────
 *
 * A property that is read on every access cannot go stale. Build this once at module scope and the
 * same object answers English before a host has set a catalogue, German after, and English again
 * for a key German has not filled — with no dependency on when it was constructed relative to the
 * provider, and no memo to invalidate. That matters because these modules are imported at the top
 * of the graph, long before any host renders.
 *
 * ── THE ARGUMENT NAMES HAVE TO BE DECLARED, AND THAT IS NOT AVOIDABLE ─────────────────────────
 *
 * An English fallback like `(n) => \`${n} attachments\`` is positional; its ICU message
 * (`{count, plural, …}`) is named. Nothing can infer one from the other, so `params` maps each
 * function key to the argument names in order. A missing entry means the message takes no values,
 * which for a function key would render it without its number — so the parity guard asserts every
 * function key in the fallback has a `params` entry.
 *
 * ── AND WHY THE FALLBACK IS STILL EVALUATED WHEN THE CATALOGUE ANSWERS ────────────────────────
 *
 * It is not: the fallback function runs only when the translator is absent or answered empty. The
 * ternary is written so the common path formats exactly one message.
 */
export function liveCopy<T extends Record<string, unknown>>(
  namespace: string,
  english: T,
  params: Partial<Record<keyof T, readonly string[]>> = {},
): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(english)) {
    const fallback = english[key];
    if (typeof fallback === "function") {
      const names = params[key as keyof T] ?? [];
      out[key] = (...values: unknown[]): string => {
        const t = activeTranslator(namespace);
        if (t === null) return (fallback as (...a: unknown[]) => string)(...values);
        const named: Record<string, unknown> = {};
        names.forEach((name, i) => { named[name] = values[i]; });
        const formatted = t(key, named);
        return formatted === "" ? (fallback as (...a: unknown[]) => string)(...values) : formatted;
      };
      continue;
    }
    Object.defineProperty(out, key, {
      enumerable: true,
      get(): unknown {
        const t = activeTranslator(namespace);
        if (t === null) return fallback;
        const formatted = t(key);
        return formatted === "" ? fallback : formatted;
      },
    });
  }
  return out as T;
}
