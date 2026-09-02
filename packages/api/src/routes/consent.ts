import {
  buildSeedReview, confirmSeed, consentSettings, cutlineCounts, mailboxFoldersOff,
  mailboxSignatures,
  resetScreeningState, setAutoSuggest, setBlockAutoUnsubscribe, setBlockRemoteImages,
  setBlockTrackingPixels,
  setDormancyDays, setFoldersEnabled, setLocale, setMailboxFoldersEnabled, setMailboxSignature,
  setOnboardingCompleted, setThemeFace,
  unmovedReport,
  DEFAULT_DORMANCY_DAYS, SEED_MAX_ADDRESSES, SUPPORTED_LOCALES, SUPPORTED_THEME_FACES,
  ServiceError,
} from "@trafficflow/services/mail";
import type { Tx } from "@trafficflow/db";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";

/** The uuid shape `folderMailboxes` keys must have — `message-service.ts`'s spelling. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * HOW MANY MAILBOXES ONE `PATCH /consent/settings` MAY NAME.
 *
 * Both per-mailbox maps (`folderMailboxes`, `signatures`) are iterated inside ONE transaction,
 * one write per entry, and each entry that names a foreign or absent id is a 404 that only
 * happens after its own query. So an unbounded map is an unbounded number of statements in one
 * transaction, chosen by the caller — and every one of them can be a miss, which makes the
 * refusal itself the expensive part.
 *
 * **A BATCH SIZE, NOT A PLAN LIMIT — and that distinction is a correction.** It was briefly
 * derived from the hosted pricing (`PLAN_LIMITS.pro.mailboxes` + `MAX_ADDON_QUANTITY` = 20, the
 * most mailboxes a paying account can hold). That is wrong here for a structural reason:
 * `consentRoutes` is mounted by `selfHostRoutes`, and a self-host deployment has NO mailbox count
 * limit at all (`SELF_HOST_MAILBOX_ALLOWANCE`). An operator with 21 mailboxes would have been
 * refused by a number that describes somebody else's price list.
 *
 * So it is 25: comfortably past the largest hosted account, and an operational ceiling on how
 * much per-mailbox settings ONE request carries. A client with more mailboxes sends two requests,
 * and nothing is lost by that — this route is a partial update, so two requests are two
 * independent writes of two disjoint maps.
 *
 * **The upper end is set by the request door, not by taste, and it is TIGHT.** `signatures`
 * values are capped at `MAILBOX_SIGNATURE_MAX_CHARS` (10 000) EACH, so this count MULTIPLIES into
 * the request body — and the multiplier is SIX bytes per character, not four, because
 * `JSON.stringify` escapes a control character as `\u00xx` and nothing here refuses one. At 25 the worst
 * legal body is ~1.5 MB and at 40 it is ~2.4 MB, both inside today's `JSON_BODY_MAX_BYTES` (3
 * MiB) — the door rose after this number was set, so 25 is now headroom rather than the edge, and
 * saying otherwise would be a rationale that stopped being true. What keeps them related is not
 * this comment: `input-bounds-census.test.ts` recomputes the product at six bytes per character
 * against the door and fails if a future bump to either makes them collide.
 *
 * One number for both maps, because they are the same shape reaching the same loop.
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

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ONBOARDING CONSENT — the five endpoints the seed, the cutline and the reset are reached by.

   The services behind these landed first and were, until this file, unreachable outside their
   own tests. Everything about the model is in the service files themselves; what this file
   owes is the wire contract and the gates.

   ── WHY THERE IS NO `ConsentService` ──────────────────────────────────────────────────────

   The consent functions take a `ServiceContext` and nothing else — no adapter, no key
   provider, no injected clock beyond the context's. There is no construction to do, so there
   is nothing for `ApiDeps.services` to hold, and adding an entry would mean every host that
   builds a deps bag has to remember to wire a capability it cannot decline. `DELETE /account`
   imports `deleteAccount` the same way and for the same reason.

   ── THE ORDER A CLIENT USES THEM IN ───────────────────────────────────────────────────────

     GET  /consent          where is this account in the flow, and how much work is waiting
     GET  /consent/seed     the review list — shown BEFORE anything acts on it
     POST /consent/seed     the confirmation. THIS is the consent event
     GET  /consent/reset    what a reset would leave physically moved, per pile
     POST /consent/reset    the reset itself

   The two GETs that precede a POST are not conveniences. Both of these actions state what
   they will do before they do it, and a screen can only make that statement from a number the
   server gave it.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** `POST /consent/seed` — the addresses the user left checked. */
interface SeedConfirmBody {
  addresses?: unknown;
}

/**
 * The confirmation's address list, validated HERE because the service takes `readonly string[]`.
 *
 * An absent or non-array body is refused rather than treated as "confirm nothing": a client
 * that sends the wrong shape would otherwise get a cheerful 200 saying zero rules were created
 * and every candidate declined, and `confirmSeed` records that decline count in
 * `account_settings`. Silence must not be recorded as a decision.
 *
 * An EMPTY array is accepted, and that is the difference: unchecking everybody is a real answer
 * a person can give on the review screen.
 */
/**
 * `PATCH /consent/settings` — the account-settings write surface. Three independent knobs, and the
 * body carries whichever the caller means to change.
 *
 *   autoSuggest        boolean — arm/disarm the metered Screener suggestions.
 *   dormancyDays       number | null — the cutline dial (1–365), or `null` for the default.
 *   blockRemoteImages  boolean — keep the per-message "Show images" flow (true), or let a
 *                      message's remote images load through the proxy (false, the default).
 *   blockTrackingPixels boolean — keep refusing beacons the proxy (true, the default), or let
 *                      them load along with the pictures (false). Mail 0072.
 *   locale             'en' | 'de' | null — the interface language, or `null` for the default
 *                      (which is also what `'en'` stores; see {@link setLocale}).
 *   themeFace          'paper' | 'ohmarchy' | null — the account-wide appearance face, or `null`
 *                      to drop the account-wide choice (unlike locale, 'paper' IS stored — see
 *                      {@link setThemeFace}).
 */
interface ConsentSettingsBody {
  autoSuggest?: unknown;
  dormancyDays?: unknown;
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
 * Validate and apply the settings write. FIELD PRESENT ⇒ ACTED ON, ABSENT ⇒ UNTOUCHED, AT LEAST
 * ONE REQUIRED — the `"x" in body` shape `setScreeningPreference` uses, replacing the old
 * refuse-if-`autoSuggest`-absent form now that a second knob shares the route.
 *
 * An EMPTY body is a 400 rather than a cheerful no-op: a PATCH that changes nothing but reports
 * success is a control that lies about having acted, the same reasoning `seedAddresses` applies to
 * an absent address list. Each present field is validated on its own terms and NOTHING coerces —
 * `autoSuggest` accepts only the two booleans (a malformed body must never arm a spender), and
 * `dormancyDays` accepts a number or `null` at the wire and lets {@link setDormancyDays} enforce the
 * integer 1–365 band (the `RangeError` the ceiling prevents is a read-time throw, so the refusal
 * belongs where the value is stored).
 *
 * ── BOTH WRITES ARE ATOMIC, SO A 400 PERSISTS NOTHING ──────────────────────────────────────
 *
 * `setAutoSuggest` COMMITS its column, and `setDormancyDays` only then enforces the 1–365 band with a
 * read-time 400. Run in sequence that left a valid `autoSuggest` persisted under a 400 response when
 * the accompanying `dormancyDays` was out of band — a partial write. The two column-scoped upserts now
 * share ONE transaction: a refusal of EITHER field rolls the other back, so the response and the row
 * never disagree. The wire-shape checks (a boolean / a number-or-null) run up front, before the
 * transaction opens, so the only refusal reachable mid-transaction is the band, whose rollback is the
 * whole point. The transaction adds atomicity only — each upsert still touches a single column plus
 * `updated_at`, so a concurrent seed confirmation is not clobbered.
 *
 * The echo carries only the fields that were acted on — `{ autoSuggestAt }`, `{ dormancyDays }`, or
 * both — so each client reads back exactly the knob it wrote.
 */
async function applyConsentSettings(
  ctx: ReturnType<typeof serviceContext>, body: ConsentSettingsBody,
): Promise<{
  autoSuggestAt?: string | null; dormancyDays?: number; blockRemoteImagesAt?: string | null;
  loadTrackingPixelsAt?: string | null;
  blockAutoUnsubscribeAt?: string | null; foldersEnabledAt?: string | null;
  folderMailboxesOff?: Record<string, string>; signatures?: Record<string, string>;
  locale?: string | null; themeFace?: string | null; onboardingCompletedAt?: string;
}> {
  const hasAuto = "autoSuggest" in body;
  const hasDormancy = "dormancyDays" in body;
  const hasImages = "blockRemoteImages" in body;
  const hasPixels = "blockTrackingPixels" in body;
  const hasAutoUnsub = "blockAutoUnsubscribe" in body;
  const hasFolders = "foldersEnabled" in body;
  const hasFolderMailboxes = "folderMailboxes" in body;
  const hasSignatures = "signatures" in body;
  const hasLocale = "locale" in body;
  const hasThemeFace = "themeFace" in body;
  const hasOnboarding = "onboardingCompleted" in body;
  if (!hasAuto && !hasDormancy && !hasImages && !hasPixels && !hasAutoUnsub && !hasFolders
      && !hasFolderMailboxes && !hasSignatures && !hasLocale && !hasThemeFace && !hasOnboarding) {
    throw new ServiceError(
      "validation_failed", 400,
      "at least one of autoSuggest, dormancyDays, blockRemoteImages, blockTrackingPixels, " +
      "blockAutoUnsubscribe, foldersEnabled, folderMailboxes, signatures, locale, themeFace or " +
      "onboardingCompleted is required",
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
   * THE CLOSED SET AT THE WIRE, and `null` is a legal MEMBER of the request rather than an absence.
   *
   * "absent" and "null" mean different things on this route and this is the field where the
   * difference is a user-visible feature: absent leaves the stored language alone (field-present ⇒
   * acted-on, like every knob here), while an explicit `null` is "put me back on the default", which
   * is how an account STOPS overriding the language its devices remembered. Collapsing them would
   * make that state unreachable except by never having chosen.
   *
   * NOTHING COERCES, on `autoSuggest`'s rule with the sign that matters here: a number, an object or
   * the string `"EN"` is refused rather than normalised, because the value goes into a column whose
   * CHECK is the only closed set in the system and a writer that guesses is how an unsupported
   * locale gets stored. The set itself is `SUPPORTED_LOCALES` — the service's constant, held to the
   * catalogue files on disk by its own test — so this route has no second opinion about which
   * languages exist.
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
    autoSuggestAt?: string | null; dormancyDays?: number; blockRemoteImagesAt?: string | null;
    loadTrackingPixelsAt?: string | null;
    blockAutoUnsubscribeAt?: string | null; foldersEnabledAt?: string | null;
    folderMailboxesOff?: Record<string, string>; signatures?: Record<string, string>;
    locale?: string | null; themeFace?: string | null; onboardingCompletedAt?: string;
  } = {};
  await (ctx.db as unknown as Tx).transaction(async (tx) => {
    const txCtx = { ...ctx, db: tx as unknown as typeof ctx.db };
    if (hasAuto) {
      out.autoSuggestAt = (await setAutoSuggest(txCtx, auto!)).autoSuggestAt;
    }
    if (hasDormancy) {
      out.dormancyDays = (await setDormancyDays(txCtx, dormancy as number | null)).dormancyDays;
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
    if (signatures) {
      // Sequential, like `folderMailboxes` above and for its reasons: each write moves the
      // settings stamp under the account's counter lock, and the echo is the WHOLE map after
      // the last write — one consistent picture, server-confirmed.
      for (const [mailboxId, signature] of signatures) {
        await setMailboxSignature(txCtx, mailboxId, signature);
      }
      out.signatures = await mailboxSignatures(txCtx.db, txCtx.accountId);
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
     * WHERE IS THIS ACCOUNT IN THE FLOW — one round trip, because the onboarding screens are a
     * state machine and a client that had to ask three questions to place itself would render
     * the wrong step first on every slow connection.
     *
     * `dormancyDays` is here for a second reason, and it is the one that makes this route
     * load-bearing rather than convenient: the client engine partitions the mirror with its own
     * `DEFAULT_DORMANCY_DAYS`, and the server counts with the account's. Two windows, one
     * account, and the client had no way to learn the server's. It is served REST-side rather
     * than as a new sync entity — the `kb_entries`/`tracker` precedent in
     * `packages/db/src/schema.ts`: a
     * per-account scalar with no delete semantics and no history is a value a client refetches,
     * not a stream it replays.
     */
    method: "GET",
    pattern: "/consent",
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
        // THE BASELINE — the instant the window is measured back from, or `null` for "this
        // account has never decided anything, measure from now" (mail 0056).
        //
        // It rides THIS response and not a second endpoint because it is half of the same
        // arithmetic `dormancyDays` is the other half of: a client holding one without the other
        // partitions its mirror differently from the server that just counted for it, and the
        // disagreement is a Screener queue whose length does not match its contents. It is sent
        // as `null` rather than omitted so a client can tell "this server read the row and found
        // no baseline" from "this server predates mail 0056" — both resolve to the same
        // pre-baseline partitioning, and the distinction is kept for the same reason
        // `blockRemoteImagesAt`'s is: the day one of them needs to act on it, the wire already
        // carries the difference.
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
     * THE ACCOUNT-SETTINGS WRITE — auto-suggest, the dormancy dial, the remote-images opt-out,
     * the auto-unsubscribe opt-out and/or the interface language, whichever the body names.
     *
     * `PATCH` rather than `POST` because it changes fields of a resource `GET /consent` already
     * serves. Field-present ⇒ acted-on, so a client moving one knob leaves the other untouched;
     * an empty body is a 400, not a silent no-op (see {@link applyConsentSettings}).
     *
     * ── `cost: "work"`, AND THE REASON IS THE AUTO-SUGGEST HALF ───────────────────────────
     *
     * A settings upsert is cheap. What earns `work` is that ONE of the two knobs — auto-suggest —
     * AUTHORISES METERED SPEND: with the flag on, the Screener buys classifier suggestions without
     * a per-batch click. `cost` asks what a handler CAN cause, and this one can cause future paid
     * AI actions, so it belongs on the side of the census an unverified account cannot reach —
     * an unverified account must not generate meaningful cost, one indirection
     * later than the gate usually looks. The dormancy dial rides the same route and is pure
     * visibility (it moves no mail, spends nothing), but `work` is an upper bound and an unverified
     * account has no dormancy state worth setting, so nothing is lost by gating it alongside. The
     * remote-images opt-out is the same case as the dial: it spends nothing and moves nothing, and
     * an unverified account has no reading preference worth storing. The auto-unsubscribe opt-out
     * is the same case again — it can only ever make the product do LESS, so gating it costs an
     * unverified account nothing it could have wanted.
     *
     * No new route, so the frozen route census in `test/spend-gate.test.ts` does not
     * move — the dial reuses the class the spender already justified.
     *
     * ── THE DIAL MUST NOT TRAVEL THROUGH A TIDY-ARMING WRITER ─────────────────────────────
     *
     * The dormancy window is deliberately here and NOT on `PATCH /account/screening`. That route's
     * writer (`setScreeningPreference`) stamps `ohbox_tidy_requested_at` on the transition into
     * `people_only`, which arms the worker's backlog re-route. The dial changes only what the
     * Screener SHOWS and must never arm a pass that MOVES mail, so it stays on this route, whose
     * writers touch one column each and move nothing.
     *
     * ── NOT IDEMPOTENT-KEYED, ON PURPOSE ────────────────────────────────────────────────────
     *
     * `options: { idempotent: true }` exists for mutations whose REPLAY would double an effect. Both
     * knobs here are set-to-a-value writes, so a replay reproduces the same state; the only thing it
     * moves is a timestamp, which is not a wrong answer to "when did this change".
     */
    method: "PATCH",
    pattern: "/consent/settings",
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
    cost: "read",
    handler: async (req, deps) => {
      const review = await buildSeedReview(serviceContext(deps, req));
      return jsonResponse(review);
    },
  },
  {
    /**
     * THE CONSENT EVENT. `work` because it writes rules.
     *
     * ── AND DELIBERATELY NOT `idempotent` ─────────────────────────────────────────────────
     *
     * It used to be, and the flag was load-bearing while a second confirm was a 409: the
     * `Idempotency-Key` replay was the only thing separating "the user clicked twice" from "a
     * retry of a first click whose 200 never arrived". `confirmSeed` no longer refuses the
     * second — it takes the account's settings row, re-reads who already has a rule from
     * inside that lock, and writes only what is missing — so pressing this twice, or twice at
     * once, produces one rule per person and two honest answers either way.
     *
     * The flag comes off rather than staying as decoration because `withIdempotency` gives
     * nothing on its own: the store is the HANDLER's job, inside its own transaction, and this
     * one never claimed the key. A route advertising replay that stores no response is a
     * promise the table makes and the code does not keep. If a reason to store one appears,
     * the flag and the in-transaction `recordIdempotent` go back together, not separately.
     */
    method: "POST",
    pattern: "/consent/seed",
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
    cost: "read",
    handler: async (req, deps) => {
      const unmoved = await unmovedReport(serviceContext(deps, req));
      return jsonResponse({ unmoved });
    },
  },
  {
    /**
     * THE RESET. `stepUp: true`, and that gate is the whole of the "dev/admin-grade" the brief
     * asked for.
     *
     * The alternatives were considered and are both wrong here. A shared secret
     * (`routes/internal.ts`, `routes/admin.ts`) authorises an OPERATOR, and this operation is
     * scoped to one account's own screening decisions — an operator-only reset would mean the
     * person who owns a mailbox cannot re-run their own onboarding without somebody with a
     * deployment secret doing it for them, which is the wrong shape for a self-serve product. A
     * bare session is not enough either: this deletes every rule the account has, which is the
     * record of every screening decision anybody ever made, and a stolen session must not be
     * able to erase it.
     *
     * So it carries the gate `DELETE /account` carries and for a smaller version of the same
     * reason. It is strictly less destructive than erasure — no message is deleted, no
     * credential is touched, and the mirror is kept — which is why it is `work` rather than
     * `ceremony`: unlike erasure it is not a right anybody is exercising on the way out, and an
     * unverified account has no screening history worth resetting.
     *
     * NOT `idempotent`. `resetScreeningState` is idempotent by construction — the second call
     * deletes nothing and reports zeroes — so an idempotency record would store a response for
     * an operation that cannot be replayed harmfully. Same reasoning as `DELETE /account`.
     */
    method: "POST",
    pattern: "/consent/reset",
    cost: "work",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const result = await resetScreeningState(serviceContext(deps, req));
      return jsonResponse(result, { seq: result.lastSeq });
    },
  },
];
