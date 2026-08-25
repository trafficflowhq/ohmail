import {
  buildSeedReview, confirmSeed, consentSettings, cutlineCounts,
  resetScreeningState, setAutoSuggest, setBlockAutoUnsubscribe, setBlockRemoteImages,
  setBlockTrackingPixels,
  setDormancyDays, setFoldersEnabled, setLocale,
  unmovedReport,
  DEFAULT_DORMANCY_DAYS, SUPPORTED_LOCALES, ServiceError,
} from "@trafficflow/services/mail";
import type { Tx } from "@trafficflow/db";
import { serviceContext } from "../context.js";
import { jsonResponse } from "../responses.js";
import type { Route } from "../router.js";
import { readBody } from "./shared.js";

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
 */
interface ConsentSettingsBody {
  autoSuggest?: unknown;
  dormancyDays?: unknown;
  blockRemoteImages?: unknown;
  blockTrackingPixels?: unknown;
  blockAutoUnsubscribe?: unknown;
  /** "Use folders" — the folders foundation's master toggle (FOLDERS-SPEC.md §6). */
  foldersEnabled?: unknown;
  locale?: unknown;
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
  blockAutoUnsubscribeAt?: string | null; foldersEnabledAt?: string | null; locale?: string | null;
}> {
  const hasAuto = "autoSuggest" in body;
  const hasDormancy = "dormancyDays" in body;
  const hasImages = "blockRemoteImages" in body;
  const hasPixels = "blockTrackingPixels" in body;
  const hasAutoUnsub = "blockAutoUnsubscribe" in body;
  const hasFolders = "foldersEnabled" in body;
  const hasLocale = "locale" in body;
  if (!hasAuto && !hasDormancy && !hasImages && !hasPixels && !hasAutoUnsub && !hasFolders && !hasLocale) {
    throw new ServiceError(
      "validation_failed", 400,
      "at least one of autoSuggest, dormancyDays, blockRemoteImages, blockTrackingPixels, " +
      "blockAutoUnsubscribe, foldersEnabled or locale is required",
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

  const out: {
    autoSuggestAt?: string | null; dormancyDays?: number; blockRemoteImagesAt?: string | null;
    loadTrackingPixelsAt?: string | null;
    blockAutoUnsubscribeAt?: string | null; foldersEnabledAt?: string | null; locale?: string | null;
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
    if (hasLocale) {
      out.locale = (await setLocale(txCtx, locale as string | null)).locale;
    }
  });
  return out;
}

function seedAddresses(body: SeedConfirmBody): string[] {
  if (!Array.isArray(body.addresses)) {
    throw new ServiceError("validation_failed", 400, "addresses must be an array of strings");
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
        // THE INTERFACE LANGUAGE — `'de'`, or `null` for "this account has no preference". Sent as
        // `null` rather than omitted, and normalised to the default rather than to a string, for
        // the same reason `blockRemoteImagesAt` is: the client has to be able to tell "this server
        // read the row and found no preference" (⇒ keep the language this device remembered) from
        // "this server is too old to carry the field" (⇒ the same thing, but for a different reason
        // it may one day need to act on). This is the ONE field on this route whose null is not a
        // switch position but a deferral to the client, so it must not be filled in here.
        locale: settings.locale,
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
