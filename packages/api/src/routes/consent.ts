import {
  buildSeedReview, confirmSeed, consentSettings, cutlineCounts, mailboxFoldersOff,
  mailboxSignatures, mailboxSignatureHtmls,
  resetScreeningState, setAutoSuggest, setBlockAutoUnsubscribe, setBlockRemoteImages,
  setBlockTrackingPixels,
  setDormancyDays, setFoldersEnabled, setLocale, setMailboxFoldersEnabled, setMailboxSignature,
  setOnboardingCompleted, setThemeFace,
  unmovedReport,
  DEFAULT_DORMANCY_DAYS, SEED_MAX_ADDRESSES, SUPPORTED_LOCALES, SUPPORTED_THEME_FACES,
  ServiceError,
} from "@trafficflow/services/mail";
import { carryDialect } from "@trafficflow/db/dialect";
import type { Tx } from "@trafficflow/db";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";

/** The uuid shape `folderMailboxes` keys must have — `message-service.ts`'s spelling. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many mailboxes one `PATCH /consent/settings` may name. Both per-mailbox maps are iterated
 * inside one transaction, one write per entry, every entry possibly a 404 with its own query — an
 * unbounded map is an unbounded number of caller-chosen statements. A batch size, not a plan
 * limit: it was briefly derived from the hosted pricing, and `consentRoutes` is mounted by
 * `selfHostRoutes`, which has no mailbox limit — 21 mailboxes would have been refused by somebody
 * else's price list. So 25; a client with more sends two requests — two independent writes of
 * disjoint maps. `signatures` values multiply into the body at six bytes per character;
 * `input-bounds-census.test.ts` recomputes the product against the door.
 */
export const SETTINGS_MAX_MAILBOX_ENTRIES = 25;

/**
 * `SEED_MAX_ADDRESSES` is a coarse absolute ceiling, NOT the review's scan limit — that constant
 * counts messages, and one message contributes every distinct recipient on it.
 *
 * The ENFORCING copy is `confirmSeed`'s, in the service, because
 * the route is not guaranteed to be the only door (see the argument at that check, and
 * `SearchService`'s date guard for the rule). The route reads the same constant so the refusal
 * happens before the per-entry validation loop below rather than after it — a hostile list costs
 * one length read on the way in, and the same 413 either way.
 */

/**
 * Onboarding consent — the five endpoints the seed, the cutline and the reset are reached by;
 * this file owes the wire contract and the gates. No `ConsentService`: the consent functions take
 * a `ServiceContext` and nothing else — nothing to construct, so nothing for `ApiDeps.services`
 * to hold (`DELETE /account` imports `deleteAccount` the same way). The order a client uses them:
 * `GET /consent` (where in the flow), `GET /consent/seed` (the review list, shown before anything
 * acts), `POST /consent/seed` (the consent event), `GET /consent/reset` (what a reset would leave
 * moved), `POST /consent/reset`. The GETs are not conveniences: both actions state what they will
 * do before doing it, from a number the server gave.
 */

/** `POST /consent/seed` — the addresses the user left checked. */
interface SeedConfirmBody {
  addresses?: unknown;
}

/**
 * The confirmation's address list, validated here because the service takes `readonly string[]`.
 * An absent or non-array body is refused rather than treated as "confirm nothing": the wrong
 * shape would otherwise get a cheerful 200 saying zero rules were created and every candidate
 * declined, and `confirmSeed` records that decline count in `account_settings` — silence must not
 * be recorded as a decision. An empty array is accepted, and that is the difference: unchecking
 * everybody is a real answer a person can give on the review screen.
 */
/**
 * `PATCH /consent/settings` — the account-settings write surface; the body carries whichever
 * knobs the caller means to change: `autoSuggest` (boolean — arm/disarm the metered Screener
 * suggestions), `dormancyDays` (number | null — the cutline dial, 1–365, `null` for the default),
 * `blockRemoteImages` (boolean — per-message "Show images" flow, default true),
 * `blockTrackingPixels` (boolean — refuse beacons at the proxy, default true; mail 0072),
 * `locale` ('en' | 'de' | null — `null` for the default, which is also what `'en'` stores; see
 * {@link setLocale}), `themeFace` ('paper' | 'ohmarchy' | null — unlike locale, 'paper' is
 * stored; see {@link setThemeFace}).
 */
interface ConsentSettingsBody {
  autoSuggest?: unknown;
  dormancyDays?: unknown;
  /**
   * `'window'` | `'all_time'` — whether the Screener's cutline exists at all (mail 0083).
   *
   * The other answer to `dormancyDays`' own question rather than a knob beside it, so the two
   * travel to ONE writer and land in ONE upsert. `all_time` means no cutoff and no dormancy.
   */
  screeningScope?: unknown;
  blockRemoteImages?: unknown;
  blockTrackingPixels?: unknown;
  blockAutoUnsubscribe?: unknown;
  /** "Use folders" — the folders foundation's master toggle (FOLDERS-SPEC.md §6). */
  foldersEnabled?: unknown;
  /**
   * Per-mailbox "Use folders" (FOLDERS-SPEC.md §17) — `{ [mailboxId]: boolean }`. Every named
   * mailbox must belong to the account; `false` switches that mailbox's folders off under the
   * master toggle, `true` switches them back on (the default).
   */
  folderMailboxes?: unknown;
  /**
   * Per-mailbox SIGNATURES (mail 0075) — `{ [mailboxId]: string | null }`. Every named mailbox
   * must belong to the account; a string stores it (bounded by the service's
   * `MAILBOX_SIGNATURE_MAX_CHARS`), `null` — and a blank string — clears it.
   */
  signatures?: unknown;
  /**
   * Per-mailbox signature MARKUP (mail 0098) — `{ [mailboxId]: string | null }`, `signatures`'
   * shape exactly. A string is reduced to the compose grammar and stored, and the plain
   * `signatures` half is DERIVED FROM IT by the service; `null` — and markup that renders to
   * nothing — clears the signature entirely.
   *
   * A mailbox may be named in THIS map or in `signatures`, never in both: one value, one door
   * (the service states the argument, and the refusal is a 400 here before anything writes).
   * The two maps also share ONE entry ceiling, because a mailbox costs one write in either.
   */
  signaturesHtml?: unknown;
  locale?: unknown;
  themeFace?: unknown;
  /**
   * `true` — the first-run flow has been LEFT, by finishing it or by cancelling it (mail 0083).
   * The only accepted value is `true`: there is no "un-complete onboarding" instruction, and a
   * `false` that silently did nothing would be a control that lies about having acted.
   */
  onboardingCompleted?: unknown;
}

/**
 * Validate and apply the settings write. Field present ⇒ acted on, absent ⇒ untouched, at least
 * one required; an empty body is a 400, not a no-op that lies about having acted. Nothing
 * coerces: `autoSuggest` accepts only the two booleans (a malformed body must never arm a
 * spender); `dormancyDays` accepts number-or-null at the wire, {@link setDormancyDays} enforcing
 * the 1–365 band where the value is stored. Both writes share one transaction, so a 400 persists
 * nothing — run in sequence, a valid `autoSuggest` was once persisted under a 400. Shape checks
 * run before the transaction opens; the echo carries only the fields acted on.
 */
async function applyConsentSettings(
  ctx: ReturnType<typeof serviceContext>, body: ConsentSettingsBody,
): Promise<{
  autoSuggestAt?: string | null; dormancyDays?: number;
  screeningScope?: "window" | "all_time"; blockRemoteImagesAt?: string | null;
  loadTrackingPixelsAt?: string | null;
  blockAutoUnsubscribeAt?: string | null; foldersEnabledAt?: string | null;
  folderMailboxesOff?: Record<string, string>; signatures?: Record<string, string>;
  signaturesHtml?: Record<string, string>;
  locale?: string | null; themeFace?: string | null; onboardingCompletedAt?: string;
}> {
  const hasAuto = "autoSuggest" in body;
  const hasDormancy = "dormancyDays" in body;
  const hasScope = "screeningScope" in body;
  const hasImages = "blockRemoteImages" in body;
  const hasPixels = "blockTrackingPixels" in body;
  const hasAutoUnsub = "blockAutoUnsubscribe" in body;
  const hasFolders = "foldersEnabled" in body;
  const hasFolderMailboxes = "folderMailboxes" in body;
  const hasSignatures = "signatures" in body;
  const hasSignaturesHtml = "signaturesHtml" in body;
  const hasLocale = "locale" in body;
  const hasThemeFace = "themeFace" in body;
  const hasOnboarding = "onboardingCompleted" in body;
  if (!hasAuto && !hasDormancy && !hasScope && !hasImages && !hasPixels && !hasAutoUnsub
      && !hasFolders && !hasFolderMailboxes && !hasSignatures && !hasSignaturesHtml
      && !hasLocale && !hasThemeFace
      && !hasOnboarding) {
    throw new ServiceError(
      "validation_failed", 400,
      "at least one of autoSuggest, dormancyDays, screeningScope, blockRemoteImages, " +
      "blockTrackingPixels, blockAutoUnsubscribe, foldersEnabled, folderMailboxes, signatures, " +
      "signaturesHtml, " +
      "locale, themeFace or onboardingCompleted is required",
    );
  }

  // Wire-shape validation for EVERY knob, into typed locals, BEFORE any write opens. Nothing coerces.
  let auto: boolean | undefined;
  if (hasAuto) {
    if (typeof body.autoSuggest !== "boolean") {
      throw new ServiceError("validation_failed", 400, "autoSuggest must be true or false");
    }
    auto = body.autoSuggest;
  }
  let dormancy: number | null | undefined;
  if (hasDormancy) {
    const d = body.dormancyDays;
    if (d !== null && typeof d !== "number") {
      throw new ServiceError("validation_failed", 400, "dormancyDays must be a number or null");
    }
    dormancy = d;
  }
  /**
   * ONLY THE TWO MEMBERS OF THE CLOSED SET, and no `null` among them.
   *
   * `dormancyDays` accepts `null` because null THERE is a real answer — "track the product
   * default". There is no such answer here: the column is `NOT NULL DEFAULT 'window'`, so a
   * `null` on the wire could only mean "I do not know", and coercing that to `'window'` would
   * turn a garbled request into "narrow this account back to a window", silently undoing an
   * explicit "all time". Same rule, same direction, as every boolean on this route.
   */
  let scope: "window" | "all_time" | undefined;
  if (hasScope) {
    if (body.screeningScope !== "window" && body.screeningScope !== "all_time") {
      throw new ServiceError(
        "validation_failed", 400, "screeningScope must be 'window' or 'all_time'",
      );
    }
    scope = body.screeningScope;
  }
  /**
   * ONLY THE TWO BOOLEANS, and the reason is the same one `autoSuggest` gives with the sign
   * flipped. There, a malformed body must not arm a spender. Here, a malformed body must not
   * silently CLEAR an opt-out: coercing `"false"`, `0` or `null` to `false` would turn a garbled
   * request into "load remote images for this account from now on", which is the one state
   * transition on this route that nobody may reach by accident.
   */
  let blockImages: boolean | undefined;
  if (hasImages) {
    if (typeof body.blockRemoteImages !== "boolean") {
      throw new ServiceError("validation_failed", 400, "blockRemoteImages must be true or false");
    }
    blockImages = body.blockRemoteImages;
  }
  /**
   * THE PIXEL SWITCH, same rule, and the direction it protects is `false`: that is the position in
   * which a beacon is fetched through the proxy and the sender learns the open. Coercing `"false"`,
   * `0` or `null` to `false` would turn a garbled request into "tell every sender when this account
   * reads their mail from now on" — so, like every boolean on this route, only the two booleans.
   */
  let blockPixels: boolean | undefined;
  if (hasPixels) {
    if (typeof body.blockTrackingPixels !== "boolean") {
      throw new ServiceError("validation_failed", 400, "blockTrackingPixels must be true or false");
    }
    blockPixels = body.blockTrackingPixels;
  }
  /**
   * THE THIRD BOOLEAN, on the rule directly above with the consequence one degree worse.
   *
   * Coercing here would not merely change what a reading pane draws — `false` is the position in
   * which screening a sender out sends a one-click unsubscribe to a stranger on the account
   * owner's behalf, and there is no undo for a request that has left. So `"false"`, `0` and `null`
   * are a 400 rather than a value, and a garbled body can never turn an opt-out back off.
   */
  let blockAutoUnsub: boolean | undefined;
  if (hasAutoUnsub) {
    if (typeof body.blockAutoUnsubscribe !== "boolean") {
      throw new ServiceError("validation_failed", 400, "blockAutoUnsubscribe must be true or false");
    }
    blockAutoUnsub = body.blockAutoUnsubscribe;
  }
  /**
   * THE FOURTH BOOLEAN — "Use folders" (FOLDERS-SPEC.md §6). The consequence of coercion here is
   * the mildest on this route (the flag gates chrome over data the mirror already holds — no
   * spend, no send, no IMAP write), and it is refused anyway because one knob accepting `"true"`
   * is how the next knob's stricter rule erodes: every boolean on this route takes exactly the
   * two booleans, or the route has two contracts.
   */
  let folders: boolean | undefined;
  if (hasFolders) {
    if (typeof body.foldersEnabled !== "boolean") {
      throw new ServiceError("validation_failed", 400, "foldersEnabled must be true or false");
    }
    folders = body.foldersEnabled;
  }
  /**
   * THE PER-MAILBOX MAP (FOLDERS-SPEC.md §17) — `{ [mailboxId]: boolean }`, validated whole
   * before anything writes, `foldersEnabled`'s strictness per entry: a value that is not
   * exactly a boolean is refused, never coerced, because one knob accepting `"false"` is how
   * the route grows two contracts. Arrays are refused too — they are objects to `typeof`, and
   * an array's indices silently becoming "mailbox ids" is precisely the kind of guess this
   * route never makes. Whether each id names a mailbox OF THIS ACCOUNT is the service's check
   * (404 inside the transaction, so a batch with one foreign id persists nothing).
   */
  let folderMailboxes: Array<[string, boolean]> | undefined;
  if (hasFolderMailboxes) {
    const m = body.folderMailboxes;
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      throw new ServiceError(
        "validation_failed", 400, "folderMailboxes must be an object of mailboxId: boolean",
      );
    }
    const entries = Object.entries(m as Record<string, unknown>);
    if (entries.length === 0) {
      throw new ServiceError("validation_failed", 400, "folderMailboxes must name at least one mailbox");
    }
    // The UPPER bound, beside the lower one — see {@link SETTINGS_MAX_MAILBOX_ENTRIES}. Refused
    // here, before the per-entry validation below, so a hostile map costs one `Object.entries`
    // rather than a uuid test and a transaction statement per key.
    if (entries.length > SETTINGS_MAX_MAILBOX_ENTRIES) {
      throw new ServiceError(
        "payload_too_large", 413,
        `folderMailboxes names ${entries.length} mailboxes; the limit is ${SETTINGS_MAX_MAILBOX_ENTRIES}`,
      );
    }
    for (const [k, v] of entries) {
      // The KEY is validated as strictly as the value (codex round 1): it binds a uuid column,
      // and a non-UUID key would otherwise surface as PostgreSQL 22P02 — a 500 wearing a
      // malformed request's clothes. Shape here, OWNERSHIP in the service (404 inside the
      // transaction): a well-formed id that names another account's mailbox is a different
      // refusal from a string that could never name one.
      if (!UUID_RE.test(k)) {
        throw new ServiceError("validation_failed", 400, "every folderMailboxes key must be a mailbox id");
      }
      if (typeof v !== "boolean") {
        throw new ServiceError("validation_failed", 400, "every folderMailboxes value must be true or false");
      }
    }
    folderMailboxes = entries as Array<[string, boolean]>;
  }
  /**
   * THE SIGNATURES MAP (mail 0075) — `{ [mailboxId]: string | null }`, validated whole before
   * anything writes, `folderMailboxes`' shape rule value for value: keys must be uuids (a
   * non-UUID key would surface as PostgreSQL 22P02 — a 500 wearing a malformed request's
   * clothes), values must be exactly a string or `null` (never coerced — a number or an object
   * stored as somebody's signature is words they did not write). Whether each id names a
   * mailbox OF THIS ACCOUNT is the service's check (404 inside the transaction, so a batch
   * with one foreign id persists nothing), and so is the length ceiling (its 400 names the
   * bound).
   */
  let signatures: Array<[string, string | null]> | undefined;
  if (hasSignatures) {
    const m = body.signatures;
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      throw new ServiceError(
        "validation_failed", 400, "signatures must be an object of mailboxId: string | null",
      );
    }
    const entries = Object.entries(m as Record<string, unknown>);
    if (entries.length === 0) {
      throw new ServiceError("validation_failed", 400, "signatures must name at least one mailbox");
    }
    // The same ceiling as `folderMailboxes` above, and the same reason: one write per entry
    // inside one transaction, with the caller choosing how many.
    if (entries.length > SETTINGS_MAX_MAILBOX_ENTRIES) {
      throw new ServiceError(
        "payload_too_large", 413,
        `signatures names ${entries.length} mailboxes; the limit is ${SETTINGS_MAX_MAILBOX_ENTRIES}`,
      );
    }
    for (const [k, v] of entries) {
      if (!UUID_RE.test(k)) {
        throw new ServiceError("validation_failed", 400, "every signatures key must be a mailbox id");
      }
      if (v !== null && typeof v !== "string") {
        throw new ServiceError("validation_failed", 400, "every signatures value must be a string or null");
      }
    }
    signatures = entries as Array<[string, string | null]>;
  }
  /**
   * The signature markup map (mail 0098) — `signatures`' shape rule value for value, plus two
   * rules that exist because there are two maps for one value. One value, one door: a mailbox
   * named in both maps is a 400 before anything writes — the wire-level twin of the service's own
   * refusal, so a batch naming twenty mailboxes cannot persist nineteen before reaching the
   * contradiction; reconciling would store a signature whose html and text say different things.
   * One ceiling, shared: a mailbox costs one write whichever map names it, so the ceiling is over
   * distinct mailboxes — which keeps `body-ceiling.ts`'s arithmetic true: two
   * independently-capped maps would have doubled the worst legal body.
   */
  let signaturesHtml: Array<[string, string | null]> | undefined;
  if (hasSignaturesHtml) {
    const m = body.signaturesHtml;
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      throw new ServiceError(
        "validation_failed", 400,
        "signaturesHtml must be an object of mailboxId: string | null",
      );
    }
    const entries = Object.entries(m as Record<string, unknown>);
    if (entries.length === 0) {
      throw new ServiceError(
        "validation_failed", 400, "signaturesHtml must name at least one mailbox",
      );
    }
    for (const [k, v] of entries) {
      if (!UUID_RE.test(k)) {
        throw new ServiceError(
          "validation_failed", 400, "every signaturesHtml key must be a mailbox id",
        );
      }
      if (v !== null && typeof v !== "string") {
        throw new ServiceError(
          "validation_failed", 400, "every signaturesHtml value must be a string or null",
        );
      }
    }
    signaturesHtml = entries as Array<[string, string | null]>;
  }
  if (signatures || signaturesHtml) {
    // The two rules above, applied to the request as a whole. Computed over the union so the
    // count is DISTINCT mailboxes, and the overlap is named before the count so a request that
    // breaks both gets the more specific answer.
    const textKeys = new Set((signatures ?? []).map(([k]) => k));
    const bothNamed = (signaturesHtml ?? []).map(([k]) => k).filter((k) => textKeys.has(k));
    if (bothNamed.length > 0) {
      throw new ServiceError(
        "validation_failed", 400,
        "a mailbox may be named in signatures or in signaturesHtml, never both",
      );
    }
    const distinct = new Set([...textKeys, ...(signaturesHtml ?? []).map(([k]) => k)]).size;
    if (distinct > SETTINGS_MAX_MAILBOX_ENTRIES) {
      throw new ServiceError(
        "payload_too_large", 413,
        `signatures names ${distinct} mailboxes; the limit is ${SETTINGS_MAX_MAILBOX_ENTRIES}`,
      );
    }
  }
  /**
   * The closed set at the wire, and `null` is a legal member of the request rather than an
   * absence: absent leaves the stored language alone (field-present ⇒ acted-on), while an
   * explicit `null` is "put me back on the default" — how an account stops overriding the
   * language its devices remembered. Collapsing them would make that state unreachable except by
   * never having chosen. Nothing coerces: a number, an object or `"EN"` is refused rather than
   * normalised, because the value goes into a column whose CHECK is the only closed set in the
   * system. The set is `SUPPORTED_LOCALES` — the service's constant, held to the catalogue files
   * by its own test — so this route has no second opinion.
   */
  let locale: string | null | undefined;
  if (hasLocale) {
    const l = body.locale;
    if (l !== null && (typeof l !== "string" || !SUPPORTED_LOCALES.includes(l))) {
      throw new ServiceError(
        "validation_failed", 400,
        `locale must be one of ${SUPPORTED_LOCALES.join(", ")}, or null`,
      );
    }
    locale = l;
  }

  /**
   * The face rides `locale`'s wire discipline exactly — nothing coerces, the set is the
   * service's constant, `null` is sendable ("drop the account-wide choice"). The one semantic
   * difference ('paper' is stored, never collapsed to NULL) lives in {@link setThemeFace},
   * where the value is stored, not here.
   */
  let themeFace: string | null | undefined;
  if (hasThemeFace) {
    const f = body.themeFace;
    if (f !== null && (typeof f !== "string" || !SUPPORTED_THEME_FACES.includes(f))) {
      throw new ServiceError(
        "validation_failed", 400,
        `themeFace must be one of ${SUPPORTED_THEME_FACES.join(", ")}, or null`,
      );
    }
    themeFace = f;
  }

  /**
   * THE ONE-VALUE KNOB — `true` and nothing else, not even `false`.
   *
   * Every other boolean on this route takes both booleans because both are meaningful states.
   * This one has no opposite: nothing in the product un-completes onboarding, and Settings →
   * "Run setup again" re-opens the flow WITHOUT clearing the stamp (the flow is entered on
   * purpose there, not because the stamp was missing). Accepting `false` as a silent no-op would
   * put a control on the wire that reports success and changes nothing; accepting it as a CLEAR
   * would invent a state transition no screen asks for. So the wire says `true` or it is a 400.
   */
  if (hasOnboarding && body.onboardingCompleted !== true) {
    throw new ServiceError("validation_failed", 400, "onboardingCompleted must be true");
  }

  const out: {
    autoSuggestAt?: string | null; dormancyDays?: number;
  screeningScope?: "window" | "all_time"; blockRemoteImagesAt?: string | null;
    loadTrackingPixelsAt?: string | null;
    blockAutoUnsubscribeAt?: string | null; foldersEnabledAt?: string | null;
    folderMailboxesOff?: Record<string, string>; signatures?: Record<string, string>;
  signaturesHtml?: Record<string, string>;
    locale?: string | null; themeFace?: string | null; onboardingCompletedAt?: string;
  } = {};
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    // The transaction arrives BRANDED: `brandDialect` wraps a handle's `transaction` so the
    // callback is handed a branded object, to any savepoint depth. This site used to stamp it by
    // hand, which worked and left every other site to remember.
    const txCtx = { ...ctx, db: tx as unknown as typeof ctx.db };
    if (hasAuto) {
      out.autoSuggestAt = (await setAutoSuggest(txCtx, auto!)).autoSuggestAt;
    }
    /* ── ONE CALL FOR THE PAIR, because they are one answer (mail 0083) ─────────────────
       The window and the mode answer the same question — "how far back does the Screener
       ask?" — and `setDormancyDays` is its single writer, so both fields reach
       `account_settings` in one upsert under one lock. Two calls would be two writers racing
       one primary key with nothing ordering them, and the pair could end up disagreeing: an
       account in `all_time` with a 90-day window under it has two answers at once.

       Each field is forwarded ONLY if the caller named it; the writer treats absent as
       untouched in both directions, and the echo carries back only what was acted on. */
    if (hasDormancy || hasScope) {
      const res = await setDormancyDays(txCtx, dormancy, scope);
      if (hasDormancy) out.dormancyDays = res.dormancyDays;
      if (hasScope) out.screeningScope = res.screeningScope;
    }
    if (hasImages) {
      out.blockRemoteImagesAt = (await setBlockRemoteImages(txCtx, blockImages!)).blockRemoteImagesAt;
    }
    if (hasPixels) {
      out.loadTrackingPixelsAt =
        (await setBlockTrackingPixels(txCtx, blockPixels!)).loadTrackingPixelsAt;
    }
    if (hasAutoUnsub) {
      out.blockAutoUnsubscribeAt =
        (await setBlockAutoUnsubscribe(txCtx, blockAutoUnsub!)).blockAutoUnsubscribeAt;
    }
    if (hasFolders) {
      // Inside the shared transaction like its siblings; the service opens its own nested one
      // (a savepoint) because its change rows and its column must land together even when a
      // caller writes it alone.
      out.foldersEnabledAt = (await setFoldersEnabled(txCtx, folders!)).foldersEnabledAt;
    }
    if (folderMailboxes) {
      // Sequential on purpose: each write allocates change-log seqs under the account's
      // counter lock, and the echo is the WHOLE map after the last write, so a batch answers
      // with one consistent picture rather than per-entry fragments.
      for (const [mailboxId, enabled] of folderMailboxes) {
        await setMailboxFoldersEnabled(txCtx, mailboxId, enabled);
      }
      out.folderMailboxesOff = await mailboxFoldersOff(txCtx.db, txCtx.accountId);
    }
    if (signatures || signaturesHtml) {
      // Sequential, like `folderMailboxes` above and for its reasons: each write moves the
      // settings stamp under the account's counter lock, and the echo is the WHOLE map after
      // the last write — one consistent picture, server-confirmed.
      for (const [mailboxId, signature] of signatures ?? []) {
        await setMailboxSignature(txCtx, mailboxId, signature);
      }
      // The markup arm passes `null` as the TEXT half: the service derives it, and a caller
      // that supplied both would already have been refused at the wire above.
      for (const [mailboxId, html] of signaturesHtml ?? []) {
        await setMailboxSignature(txCtx, mailboxId, null, html);
      }
      // BOTH maps travel back whichever one was written, because a write to either CHANGES
      // both columns — a markup save derives the text, and a plain save clears the markup. An
      // echo carrying only the map that was posted would leave the pane rendering a stale half.
      out.signatures = await mailboxSignatures(txCtx.db, txCtx.accountId);
      out.signaturesHtml = await mailboxSignatureHtmls(txCtx.db, txCtx.accountId);
    }
    if (hasLocale) {
      out.locale = (await setLocale(txCtx, locale as string | null)).locale;
    }
    if (hasThemeFace) {
      out.themeFace = (await setThemeFace(txCtx, themeFace as string | null)).themeFace;
    }
    if (hasOnboarding) {
      // Inside the SHARED transaction like every knob above it, which is what makes the flow's
      // last act atomic with anything it writes alongside — a cancel that also parks a dial
      // either records both or records neither.
      out.onboardingCompletedAt =
        (await setOnboardingCompleted(txCtx)).onboardingCompletedAt;
    }
  });
  return out;
}

function seedAddresses(body: SeedConfirmBody): string[] {
  if (!Array.isArray(body.addresses)) {
    throw new ServiceError("validation_failed", 400, "addresses must be an array of strings");
  }
  // Before the per-entry loop, so an oversized list costs one length read — see
  // Before the per-entry loop, so an oversized list costs one length read. `SEED_MAX_ADDRESSES` is
  // a coarse absolute ceiling and deliberately NOT the review's scan limit — see its docstring.
  if (body.addresses.length > SEED_MAX_ADDRESSES) {
    throw new ServiceError(
      "payload_too_large", 413,
      `addresses names ${body.addresses.length} senders; at most ${SEED_MAX_ADDRESSES} may be confirmed at once`,
    );
  }
  const out: string[] = [];
  for (const a of body.addresses) {
    if (typeof a !== "string") {
      throw new ServiceError("validation_failed", 400, "addresses must be an array of strings");
    }
    out.push(a);
  }
  return out;
}

export const consentRoutes: Route[] = [
  {
    /**
     * Where is this account in the flow — one round trip, because the onboarding screens are a
     * state machine and a client that asked three questions would render the wrong step first on
     * every slow connection. `dormancyDays` is here for the load-bearing reason: the client
     * engine partitions the mirror with its own `DEFAULT_DORMANCY_DAYS` while the server counts
     * with the account's — two windows, one account, and the client had no way to learn the
     * server's. Served REST-side rather than as a sync entity (the `kb_entries`/`tracker`
     * precedent): a per-account scalar with no delete semantics and no history is a value a
     * client refetches, not a stream it replays.
     */
    method: "GET",
    pattern: "/consent",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const settings = await consentSettings(ctx);
      const dormancyDays = settings.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
      // BOTH SIDES OF THE CUTLINE FROM ONE READ. The count below and the `screeningBaselineAt`
      // sent to the client are computed from the SAME `settings` row, so the number the shell
      // shows and the partition it draws can never be measured from different baselines — which
      // is the failure a second `consentSettings()` call, or a client that fetched the baseline
      // on its own, would eventually produce.
      const baselineAt = settings.screeningBaselineAt === null
        ? null
        : new Date(settings.screeningBaselineAt);
      const counts = await cutlineCounts(ctx, { dormancyDays, baselineAt });
      return jsonResponse({
        seedConfirmedAt: settings.seedConfirmedAt,
        screeningResetAt: settings.screeningResetAt,
        // Always a number, never null: the client needs a window to partition with, and
        // "the account has not overridden it" is not something a partition can act on.
        dormancyDays,
        // The baseline — the instant the window is measured back from, or `null` for "this
        // account has never decided anything, measure from now" (mail 0056). It rides this
        // response because it is half of the same arithmetic `dormancyDays` is the other half of:
        // a client holding one without the other partitions its mirror differently from the
        // server that just counted, and the disagreement is a Screener queue whose length does
        // not match its contents. Sent as `null` rather than omitted so a client can tell "read
        // the row, found no baseline" from "this server predates mail 0056" — the wire already
        // carries the difference for the day one of them acts on it.
        screeningBaselineAt: settings.screeningBaselineAt,
        // AUTO-SUGGEST, as the INSTANT it was turned on or `null` for off. Deliberately not
        // normalised to a boolean the way `dormancyDays` is normalised to a number: a window is
        // useless to a client without a value, whereas "off" is a complete and actionable
        // answer, and "when was this turned on" is a fact the support thread will want. The
        // client's rule is the same as the service's — `null`, absent, or a failed fetch all
        // read as OFF, because ON authorises spending.
        autoSuggestAt: settings.autoSuggestAt,
        // REMOTE IMAGES, as the instant the account OPTED OUT of automatic loading, or `null`
        // for the product default (they load). Not normalised to a boolean, for the same reason
        // `autoSuggestAt` is not — "when did this change" is a real question — and deliberately
        // sent as `null` rather than omitted, so a client can tell "this server read the row and
        // found no opt-out" from "this server is too old to have the field", which is the one
        // distinction that decides whether it may load a remote image at all.
        blockRemoteImagesAt: settings.blockRemoteImagesAt,
        // TRACKING PIXELS, as the instant the account asked for them to LOAD, or `null` for the
        // product default (they are blocked). The sign is the reverse of the field above: here
        // `null` is the PROTECTIVE posture, so a client that reads `undefined` from an older API
        // and one that reads `null` from this one land on the same answer — blocked — and that
        // collapse is safe precisely because it can only ever refuse a beacon, never fetch one.
        loadTrackingPixelsAt: settings.loadTrackingPixelsAt,
        // AUTO-UNSUBSCRIBE, as the instant the account turned it OFF, or `null` for the product
        // default (a screen-out still sends the one-click request). Sent as `null` rather than
        // omitted for `blockRemoteImagesAt`'s reason with the branches the other way round: the
        // client uses this to decide whether to STATE the consequence before somebody screens a
        // sender out, and `null` — "this server read the row and found no opt-out" — is what makes
        // that sentence true. An older client that never sees the field keeps showing it, which is
        // also what the server is still doing.
        blockAutoUnsubscribeAt: settings.blockAutoUnsubscribeAt,
        // "USE FOLDERS", as the instant it was turned on or `null` for off — `autoSuggestAt`'s
        // shape for `autoSuggestAt`'s reasons: "when was this turned on" is a real fact, and
        // `null`, absent, and a failed fetch all read as OFF on the client, which is the
        // pre-feature interface byte for byte (FOLDERS-SPEC.md §10).
        foldersEnabledAt: settings.foldersEnabledAt,
        // PER-MAILBOX "USE FOLDERS" — only the EXCEPTIONS travel (`{ mailboxId: instant }`,
        // FOLDERS-SPEC.md §17). A mailbox absent from the map participates, which is what the
        // column's NULL means and what an older client that never reads the field assumes; an
        // older SERVER simply omits the field, and the client's absent-means-none read is the
        // same picture. The instants, not booleans, for `foldersEnabledAt`'s reason.
        folderMailboxesOff: await mailboxFoldersOff(ctx.db, ctx.accountId),
        // PER-MAILBOX SIGNATURES (mail 0075) — only the mailboxes that HAVE one travel
        // (`{ mailboxId: text }`). A mailbox absent from the map has no signature, which is
        // what the column's NULL means and what an older client that never reads the field
        // assumes; an older SERVER simply omits the field, and the client's absent-means-none
        // read is the same picture.
        signatures: await mailboxSignatures(ctx.db, ctx.accountId),
        // PER-MAILBOX SIGNATURE MARKUP (mail 0098) — only the mailboxes whose signature has
        // formatting in it. An absent key here is "no formatting", NEVER "no signature":
        // the map above answers that, and the two are read together. Present-and-empty for
        // `signatures`' reason — a client can tell this server having read the rows from one
        // too old to carry the field, and both pictures render the same.
        signaturesHtml: await mailboxSignatureHtmls(ctx.db, ctx.accountId),
        // THE INTERFACE LANGUAGE — `'de'`, or `null` for "this account has no preference". Sent as
        // `null` rather than omitted, and normalised to the default rather than to a string, for
        // the same reason `blockRemoteImagesAt` is: the client has to be able to tell "this server
        // read the row and found no preference" (⇒ keep the language this device remembered) from
        // "this server is too old to carry the field" (⇒ the same thing, but for a different reason
        // it may one day need to act on). This is the ONE field on this route whose null is not a
        // switch position but a deferral to the client, so it must not be filled in here.
        locale: settings.locale,
        // THE APPEARANCE FACE — `'paper' | 'ohmarchy'`, or `null` for "no account-wide choice".
        // Sent as `null` rather than omitted for `locale`'s reason, with the face's own twist:
        // null defers to the DEVICE, whose default is not a constant (a Linux device resolves
        // it to ohmarchy — the Option B detection the client owns).
        themeFace: settings.themeFace,
        // WHEN THE FIRST-RUN FLOW WAS LAST LEFT, or `null` for "never" (mail 0083). It rides THIS
        // response rather than a route of its own for `dormancyDays`'s reason: the flow's step is
        // DERIVED from truth-conditions and a client that had to ask two endpoints to place
        // itself would render the wrong step first on every slow connection. The three other
        // conditions it is read beside — the consent stamp, the baseline, the import stamp — are
        // already reachable in one round trip each from state the shell holds, and this is the
        // fourth. Sent as `null` rather than omitted so a client can tell a server that read the
        // row from one too old to have the column; both open the flow, which is the safe
        // direction (the worst case is a screen with a Cancel on it).
        onboardingCompletedAt: settings.onboardingCompletedAt,
        // THE SCREENING MODE — `'window'` or `'all_time'` (mail 0083). Half of the same cutline
        // arithmetic `dormancyDays` and `screeningBaselineAt` are the other halves of, and it must
        // travel with them for the reason stated there: a client holding the dial without the mode
        // partitions its mirror differently from the server that just counted for it, and the
        // disagreement is a Screener queue whose length does not match its contents. Always one of
        // the two strings — the column is NOT NULL with a default, so there is no unknown to send.
        screeningScope: settings.screeningScope,
        counts,
      });
    },
  },
  {
    /**
     * The account-settings write — auto-suggest, the dormancy dial, the remote-images and
     * auto-unsubscribe opt-outs, the language. `PATCH`; field-present ⇒ acted-on; empty body 400.
     * `cost: "work"` because of auto-suggest: with the flag on, the Screener buys classifier
     * suggestions without a per-batch click — future paid AI actions; the other knobs spend
     * nothing. The dial must not travel through a tidy-arming writer: `setScreeningPreference`
     * stamps `ohbox_tidy_requested_at`, arming a pass that moves mail, so the dial stays here.
     * Not idempotent-keyed: set-to-a-value writes replay to the same state.
     */
    method: "PATCH",
    pattern: "/consent/settings",
    relay: true,
    cost: "work",
    handler: async (req, deps) => {
      const ctx = serviceContext(deps, req);
      const body = await readBody<ConsentSettingsBody>(req);
      return jsonResponse(await applyConsentSettings(ctx, body));
    },
  },
  {
    /**
     * THE REVIEW LIST. `cost: "read"` and it stays that way.
     *
     * It is the most expensive read in the table — up to `SEED_SCAN_LIMIT` rows joined to
     * `message_bodies` — and `cost` is not a size, it is a question about what the handler
     * CAUSES. This one reads rows already stored for the caller's own account and writes
     * nothing, opens no socket and calls no metered third party. Reclassifying it `work` would
     * refuse it to an unverified account, and this is a screen in the FIRST five minutes of an
     * account's life; verification and onboarding overlap by construction.
     */
    method: "GET",
    pattern: "/consent/seed",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const review = await buildSeedReview(serviceContext(deps, req));
      return jsonResponse(review);
    },
  },
  {
    /**
     * The consent event. `work` because it writes rules. Deliberately not `idempotent`: the flag
     * was load-bearing while a second confirm was a 409 — `confirmSeed` no longer refuses the
     * second: it takes the settings row, re-reads who already has a rule inside that lock, and
     * writes only what is missing, so pressing twice, or twice at once, produces one rule per
     * person and two honest answers. The flag comes off rather than staying as decoration: the
     * store is the handler's job, inside its transaction, and this one never claimed the key. If
     * a reason to store a response appears, the flag and `recordIdempotent` go back together.
     */
    method: "POST",
    pattern: "/consent/seed",
    relay: true,
    cost: "work",
    handler: async (req, deps) => {
      const body = await readBody<SeedConfirmBody>(req);
      const result = await confirmSeed(serviceContext(deps, req), seedAddresses(body));
      return jsonResponse(result, { seq: result.lastSeq });
    },
  },
  {
    /**
     * WHAT A RESET WOULD LEAVE BEHIND, before anybody presses anything.
     *
     * The reset moves no mail — it cannot honestly un-make thousands of IMAP moves that are
     * indistinguishable from moves the user made by hand — so the screen in front of it has to
     * say what will still be sitting in `ohmail/*` afterwards. This is that number, per pile,
     * and it is read-only: safe to call, and safe to call twice.
     */
    method: "GET",
    pattern: "/consent/reset",
    relay: true,
    cost: "read",
    handler: async (req, deps) => {
      const unmoved = await unmovedReport(serviceContext(deps, req));
      return jsonResponse({ unmoved });
    },
  },
  {
    /**
     * The reset. `stepUp: true` is the gate. A shared secret authorises an operator, and this
     * operation is scoped to one account's own screening decisions — an operator-only reset is
     * the wrong shape for a self-serve product. A bare session is not enough either: this deletes
     * every rule the account has, the record of every screening decision, and a stolen session
     * must not erase it. So it carries the gate `DELETE /account` carries, for a smaller version
     * of the same reason. `work` rather than `ceremony`: unlike erasure it is not a right
     * exercised on the way out, and an unverified account has no screening history worth
     * resetting. Not `idempotent`: the second call deletes nothing and reports zeroes.
     */
    method: "POST",
    pattern: "/consent/reset",
    relay: true,
    cost: "work",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const result = await resetScreeningState(serviceContext(deps, req));
      return jsonResponse(result, { seq: result.lastSeq });
    },
  },
];
