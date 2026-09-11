"use client";

/**
 * Where this account stands in onboarding, and the dormancy window it is counted with — one `GET /consent` per
 * tab. The dial comes over REST, not `/sync`: a per-account integer with no history is not a change to mail, and
 * the accepted cost is stated — a second tab keeps the old window until it reloads, which only makes a Screener
 * queue briefly the wrong length. The boot applies the device's CACHED last answer first (`boot-cache.ts` — the
 * three partition inputs, nothing that authorises anything): a partition that waited for the fetch presented the
 * raw piles for the whole round trip, resurrecting already-decided Screener senders on every reload. A failure is
 * silent: the default is the product default, or the cache — strictly closer to the account's truth; a network
 * blip must not produce an error anybody has to read.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/client-engine";
import { apiConfigured, consent as consentApi, type ConsentStateWire } from "../api-client";
import { readBootCache, writeBootCache } from "./boot-cache";
import { normalizeLocale, type AppLocale } from "./locale";
import { readOwner } from "./owner-cookie";

/**
 * The five calls this hook makes, gathered into something a host can hand in — the `AwayTransport`/`SuggestWire`
 * seam, for the identical reason: `apiConfigured()` is false in every desktop build, so the fetch never ran there,
 * `known` stayed false, and the dormancy dial, auto-suggest opt-in and auto-unsubscribe were withheld — right for
 * standalone (no account), wrong for the hosted door, whose engine forwards `/consent` with the bearer. Only the
 * WIRE is injected, never the controls: `autoSuggest` is the one flag that authorises spending, and its
 * echo-not-the-argument discipline and single `setState` are decided above this seam — a second implementation is a
 * second answer to "is auto-suggest on", and the direction that costs money is where they disagree. Methods are
 * shaped like `api-client`'s own `consent` object, the default.
 */
export interface ConsentTransport {
  /**
   * Can the server behind this wire actually STORE the folders flag — the one capability this transport
   * declares, because the route cannot be asked. `foldersRoutes` are mounted on the hosted table alone;
   * `localRoutes` wraps the consent group in `withoutFoldersFlag` (read forces `foldersEnabledAt` null,
   * PATCH drops the field silently, so no client can raise a flag whose verbs would 404). That wrapper is
   * invisible from here — the GET answers 200, `known` goes true, and the shared shell drew the whole
   * Folders pane on standalone: a switch that flips, writes nothing, snaps back. Declared by whoever
   * built the wire — the only place that knows the route table. Required, not optional: an absent field
   * would select the branch that draws the dead pane.
   */
  foldersStorable: boolean;
  state: () => Promise<ConsentStateWire>;
  setAutoSuggest: (enabled: boolean) => Promise<{ autoSuggestAt: string | null }>;
  /**
   * THE SCREENING WINDOW AND ITS MODE — one call, because they are one answer (mail 0083).
   *
   * Either argument may be omitted, and omitted means UNTOUCHED: Settings names both when the
   * person picks a number and only the mode when they pick "all time". The echo carries back
   * only the halves that were acted on, which is what the hook folds into its state.
   */
  setDormancyDays: (
    days: number | null | undefined, scope?: "window" | "all_time",
  ) => Promise<{ dormancyDays?: number; screeningScope?: "window" | "all_time" }>;
  setBlockRemoteImages: (blocked: boolean) => Promise<{ blockRemoteImagesAt: string | null }>;
  setBlockTrackingPixels: (blocked: boolean) => Promise<{ loadTrackingPixelsAt: string | null }>;
  setBlockAutoUnsubscribe: (blocked: boolean) => Promise<{ blockAutoUnsubscribeAt: string | null }>;
  setFoldersEnabled: (enabled: boolean) => Promise<{ foldersEnabledAt: string | null }>;
  setMailboxFoldersEnabled: (
    mailboxId: string, enabled: boolean,
  ) => Promise<{ folderMailboxesOff: Record<string, string> }>;
  /**
   * Per-mailbox signature (mail 0075): a string stores, `null` clears;
   * echoes the whole map. `signatureHtml` (mail 0098) carries the MARKUP
   * shape instead, and the server derives the text half from it. Exactly
   * one of the two carries the value — a call supplying both is refused at
   * the route — so the markup form passes `null` as the text. The markup
   * echo is optional on the way back: a host too old to have the column
   * omits it, which reads as "no signature anywhere has formatting" —
   * exactly the picture that server serves.
   */
  setMailboxSignature: (
    mailboxId: string, signature: string | null, signatureHtml?: string | null,
  ) => Promise<{
    signatures: Record<string, string>;
    signaturesHtml?: Record<string, string>;
  }>;
  /**
   * The account-wide appearance face (mail 0082) — OPTIONAL, unlike every method above, because
   * the desktop's hosted-door transport predates it and must keep compiling; a host that does
   * not supply it simply withholds the "apply for all devices" affordance (the device-local
   * pin still works there — it never touches this wire). `'paper'` stores as itself, never
   * collapsed to null; see the api-client note.
   */
  setThemeFace?: (themeFace: string | null) => Promise<{ themeFace: string | null }>;
}

/** The hosted transport — the browser talking to the API this app was written against. */
const CLOUD_CONSENT: ConsentTransport = {
  /* The managed API mounts `foldersRoutes`, so this is true of the browser
     tab this transport was written for — a static claim about a route table
     this client cannot interrogate. A self-host server inherits
     `withoutFoldersFlag`, so its web client draws the same pane that cannot
     store, and this constant says otherwise; a desktop self-host door takes
     the hosted wire and inherits the same wrong answer. The honest answer
     is the server's to give: `features` on `/hello` — one `folders` word
     closes all three surfaces. Until then this is exact for the managed
     deployment and one release ahead of the truth for a self-hosted one.
     See `apps/desktop/src/local-consent.ts`. */
  foldersStorable: true,
  state: () => consentApi.state(),
  setAutoSuggest: (enabled) => consentApi.setAutoSuggest(enabled),
  setDormancyDays: (days, scope) => consentApi.setDormancyDays(days, scope),
  setBlockRemoteImages: (blocked) => consentApi.setBlockRemoteImages(blocked),
  setBlockTrackingPixels: (blocked) => consentApi.setBlockTrackingPixels(blocked),
  setBlockAutoUnsubscribe: (blocked) => consentApi.setBlockAutoUnsubscribe(blocked),
  setFoldersEnabled: (enabled) => consentApi.setFoldersEnabled(enabled),
  setMailboxFoldersEnabled: (mailboxId, enabled) =>
    consentApi.setMailboxFoldersEnabled(mailboxId, enabled),
  setMailboxSignature: (mailboxId, signature) =>
    consentApi.setMailboxSignature(mailboxId, signature),
  setThemeFace: (themeFace) =>
    consentApi.setThemeFace(themeFace).then((stored) => ({ themeFace: stored })),
};

export interface ConsentState {
  /** Null until the seed review has been confirmed. Drives which onboarding step is shown. */
  seedConfirmedAt: string | null;
  /** ALWAYS a number, so a partition can always be computed. */
  dormancyDays: number;
  /**
   * When this account finished screening its backlog, or null for "measure from now" — the
   * second half of the cutline arithmetic, and the one field NOT normalised: null must reach
   * `consentPartition` as null, since it selects the pre-baseline behaviour (sliding window,
   * unread outranks age), and substituting `now` would apply the narrowed rule to an account
   * that never established a baseline — dropping every undecided sender with older mail
   * straight into History. Resting null; so is a failed fetch, an old API, and standalone — all
   * four keep today's partition, and the worst case is the sliding window itself.
   */
  screeningBaselineAt: string | null;
  /** Senders still owed a decision, as the SERVER counts them. */
  activeUndecidedSenders: number;
  /**
   * IS AUTO-SUGGEST ON — the one field on this object that authorises spending.
   *
   * A boolean and not the instant, because the only consumer asks a yes/no question. It starts
   * FALSE and stays false unless the server said otherwise, which is the direction that matters:
   * `RESTING` is false, a failed fetch leaves `RESTING` in place, an API too old to carry the
   * field sends `undefined`, and all three read as off. There is no path here from "I do not
   * know" to "buy something".
   */
  autoSuggest: boolean;
  /**
   * WHEN it was turned on, for the settings row that says so. Null whenever it is off.
   *
   * Kept beside {@link autoSuggest} rather than replacing it, because the two answer different
   * questions and only one of them authorises spending. Nothing may branch on this field: it is
   * display only, and `autoSuggest` stays the single boolean the spender reads — a second
   * derivation of "is it on" is how the two get to disagree.
   */
  autoSuggestAt: string | null;
  /**
   * Does this account keep the per-message "Show images" flow? True = manual, the old
   * behaviour; false = the product default (remote images load through the proxy on open). It
   * starts TRUE — the opposite of every other flag here, deliberately: {@link autoSuggest}
   * starts false because ON authorises spending; here the dangerous direction is reversed — "I
   * do not know" must not LOAD anything, because the account may have opted out where this
   * build cannot see. A failed read, an old API, and a no-API build all keep today's
   * per-message button; only a successful read carrying `blockRemoteImagesAt: null` moves it to
   * false.
   */
  blockRemoteImages: boolean;
  /** When they opted out, for the settings row that says so. Null whenever images load. */
  blockRemoteImagesAt: string | null;
  /**
   * ARE TRACKING PIXELS REFUSED THE PROXY? True = the product default (mail 0072).
   *
   * **It starts TRUE, and here — unlike {@link blockRemoteImages} — the safe resting value IS the
   * default one.** A failed `GET /consent`, an API too old to carry the field, and a build with no
   * API all leave this true, and so does a server that read the row and found no opt-out; the
   * three are one answer because blocking is the protective posture and the worst a wrong "true"
   * can do is refuse a beacon somebody wanted fetched. Only a successful read carrying a stored
   * instant moves it to false.
   */
  blockTrackingPixels: boolean;
  /** When they asked pixels to load, for the settings row that says so. Null while blocked. */
  loadTrackingPixelsAt: string | null;
  /**
   * Does screening a sender out also unsubscribe from their list? True = the product default —
   * and unlike {@link blockRemoteImages}, the safe direction here IS the default: nothing on
   * the client sends anything (the server reads its own row); this flag only decides whether
   * the interface SAYS SO around the click. "I do not know" resolving to false would silently
   * drop the disclosure of an irreversible outbound request that is still happening — worse
   * than disclosing one that turns out not to run. Every failure mode leaves this true, which
   * is also exactly what the interface did before the switch existed.
   */
  autoUnsubscribe: boolean;
  /** When they turned it off, for the settings row that says so. Null while the pass runs. */
  blockAutoUnsubscribeAt: string | null;
  /**
   * ARE THE MAILBOX'S OWN FOLDERS SHOWN — "Use folders", the folders feature's master toggle
   * (FOLDERS-SPEC.md §6; owner decision 1: fully optional, disabled by default).
   *
   * It starts FALSE and stays false unless the server said otherwise — `autoSuggest`'s
   * direction, though for a weaker reason: this authorises no spend and no send, it only
   * decides whether the rail grows a group, the folder views open and the Settings pane shows
   * its content. An API too old to carry the field sends `undefined`, which reads as off — the
   * pre-feature interface, byte for byte, which is the flag-off parity claim (spec §10).
   */
  foldersEnabled: boolean;
  /** When it was turned on, for the settings row that says so. Null whenever it is off. */
  foldersEnabledAt: string | null;
  /**
   * PER-MAILBOX "Use folders", stored as the EXCEPTIONS — `{ mailboxId: instant switched off }`
   * (FOLDERS-SPEC.md §17). A mailbox absent from the map participates, which is the ruling's
   * default; an empty map is every mailbox showing. Only the Settings pane reads this — the
   * rail needs nothing, because the server already withholds a switched-off mailbox's
   * entities from `/sync`.
   */
  folderMailboxesOff: Record<string, string>;
  /**
   * Did {@link folderMailboxesOff} come from the LIVE wire (or a write's echo)? The boot cache
   * paints `known` true with the MASTER flag alone — it deliberately carries no per-mailbox map
   * — so a pane gated on `known` would render every mailbox's switch ON over stored opt-outs
   * until the live read lands, and for ever if it fails (codex round 1). The switches render
   * only behind this flag; the master toggle keeps rendering on `known` as before.
   */
  folderMailboxesKnown: boolean;
  /**
   * PER-MAILBOX SIGNATURES — `{ mailboxId: text }`, only the mailboxes that have one (mail
   * 0075). Read by the Settings pane's editors and by every compose surface's signature block;
   * an absent key is "this mailbox signs with nothing", which is the resting state.
   */
  signatures: Record<string, string>;
  /**
   * PER-MAILBOX SIGNATURE MARKUP — `{ mailboxId: html }`, only the mailboxes whose signature has
   * formatting in it (mail 0098).
   *
   * AN ABSENT KEY IS "NO FORMATTING", NEVER "NO SIGNATURE". {@link signatures} answers the
   * latter, and the two are read together: the Settings editors seed from both, and a compose
   * block renders the markup when it has one and the text otherwise. It shares
   * {@link signaturesKnown} rather than carrying a flag of its own — the two maps arrive in one
   * response and a surface that has one has both, so a second flag could only ever disagree.
   */
  signaturesHtml: Record<string, string>;
  /**
   * Did {@link signatures} come from the LIVE wire (or a write's echo)? `folderMailboxesKnown`'s
   * rule for the same reason: the boot cache carries no signatures, so a pane gated on `known`
   * alone would render empty editors over stored text until the live read lands — and a compose
   * block would silently omit a signature the account has. Surfaces that RENDER stored
   * signatures gate on this flag; false means "not yet known", never "none".
   */
  signaturesKnown: boolean;
  /**
   * The account's interface language, or `null` for "no preference" — the
   * one field whose null is a DEFERRAL rather than a switch position, and
   * the only one a consumer must not normalise: `AppShell` adopts a
   * non-null value at boot, overriding the device's remembered language,
   * and that guard only works if `null` reaches the consumer as null.
   * Resting null; so is a failed fetch, an old API, and standalone — all
   * four leave the device's own choice standing, and the worst case is an
   * interface in the language the reader last picked on this machine.
   */
  locale: AppLocale | null;
  /**
   * THE ACCOUNT'S APPEARANCE FACE, or `null` for "no account-wide choice" — `locale`'s twin,
   * with `locale`'s deferral semantics: null is the ABSENCE of a position, and it leaves the
   * device to resolve its own default (its pin, then the Linux detection — `ThemeProvider`
   * owns that order, this hook only reports what the account said). Resting null, failed
   * fetch null, elderly API null, standalone null: all four mean "nothing from an account",
   * and the worst case of not knowing is the face this device already wears.
   */
  themeFace: "paper" | "ohmarchy" | null;
  /**
   * Did {@link themeFace} come from the LIVE wire (or a write's echo)? `signaturesKnown`'s
   * rule, and here the stake is a WRITE gate (review-caught): the boot cache carries no face,
   * so `known` alone can be true while `themeFace` is still the resting null — and an
   * adoption or an "apply for all devices" armed on that state would wipe the device's
   * mirror of the account's real answer, or offer ohmarchy over an account that explicitly
   * chose paper, before the live read lands. False means "not yet known", never "none".
   */
  themeFaceKnown: boolean;
  /** False until the first answer lands — an onboarding step must not flash before then. */
  known: boolean;
  /**
   * There is no consent endpoint behind this build, and there never will be — the desktop's standalone door.
   * {@link known} gates on "partitioning on a GUESSED window would hide somebody's mail", which presupposes a
   * stored window this client has not yet read; standalone has no stored window, and reading `known: false`
   * as "not yet" switched the cutline off for the whole desktop tier — no History pile, senders queued for
   * ever. `DEFAULT_DORMANCY_DAYS` is not a guess there: it is the only window the build has. "Nothing to
   * reach", not "no Cloud client in this bundle": false wherever a host handed in a {@link ConsentTransport}
   * (the hosted door forwards these routes). Not reachable on the web (`createEngine` throws
   * `EngineUnarmedError`); false on the demo, which is `active: false`.
   */
  standalone: boolean;
  /**
   * Does this bundle carry the browser's Cloud client — a fact about the BUILD, and the question {@link
   * standalone} used to answer before it started answering a better one. Published here because
   * `AppShell` may not import `app/api-client` (published mirror) and this hook reads `apiConfigured()`
   * anyway. Two questions with different answers on the desktop's hosted door: "is there a server to
   * reach?" — {@link standalone}, transport-aware; "can a hosted CEREMONY run in this window?" — this
   * one: the seed review and the remote-image proxy call `app/api-client` DIRECTLY, so no transport
   * makes them work; false ⇒ the shell withholds them. Not a state field: settled before first render,
   * derived, so a `setState` cannot leave it behind.
   */
  cloudClient: boolean;
  /**
   * CAN THE SERVER BEHIND THIS WIRE STORE THE FOLDERS FLAG — the transport's own declaration,
   * republished so the one consumer that must not draw a dead pane can read it beside `known`.
   *
   * Derived from the live wire rather than stored, exactly as {@link cloudClient} is, so no
   * `setState` can leave it behind and no resting value can be mistaken for an answer. See
   * {@link ConsentTransport.foldersStorable} for what the field asserts and what it cost.
   */
  foldersStorable: boolean;
  /**
   * When the first-run flow was last left — finished OR cancelled, both stamp it — or `null`
   * for "never been through setup". The one truth-condition in `deriveOnboardingStep` about the
   * FLOW rather than a mailbox, and the arm that runs first: without it, an account that
   * cancelled on the consent screen re-opens setup at every boot. Resting null is the DANGEROUS
   * direction here, and {@link known} is the guard: `null` reads as "setup never done", so a
   * failed read or first render would each put a setup dialog over somebody's mail — hence the
   * stage is gated on the PAIR at the mount site: this field says where a run stands, `known`
   * says whether anybody answered at all.
   */
  onboardingCompletedAt: string | null;
  /**
   * The screening mode — `'window'` (cutline `screeningBaselineAt − dormancyDays`) or
   * `'all_time'` (no cutline; nothing lands in History unscreened). The third piece of the
   * cutline arithmetic this object was missing: a client holding two of the three partitions
   * its mirror differently from the server that counted for it. Read here so a re-run of setup
   * pre-fills the window choice from what the account stored — a re-run showing "One year" over
   * an all-time account would misreport the state it is about to change. `'window'` at rest; an
   * unrecognised string collapses to it, the pre-mode behaviour.
   */
  screeningScope: "window" | "all_time";
}

const RESTING: ConsentState = {
  seedConfirmedAt: null,
  dormancyDays: DEFAULT_DORMANCY_DAYS,
  // NO BASELINE FROM AN ACCOUNT ⇒ the sliding window, which is what every build did before mail
  // 0056. Unlike `dormancyDays` one line above, this one is NOT filled in with a plausible
  // default: `DEFAULT_DORMANCY_DAYS` is the window the engine uses unasked, whereas a guessed
  // baseline is an assertion that somebody finished screening. See {@link ConsentState.screeningBaselineAt}.
  screeningBaselineAt: null,
  activeUndecidedSenders: 0,
  autoSuggest: false,
  autoSuggestAt: null,
  // MANUAL AT REST. See {@link ConsentState.blockRemoteImages}: this is the one field whose safe
  // resting value is the non-default one, because the failure it guards against is loading a
  // sender's content for somebody who asked us not to.
  blockRemoteImages: true,
  blockRemoteImagesAt: null,
  // BLOCKED AT REST — the product default AND the protective posture at once, so unlike the pair
  // above there is no tension here: a tab that does not know refuses a beacon, which is what
  // every account that never opened the setting is doing anyway.
  blockTrackingPixels: true,
  loadTrackingPixelsAt: null,
  // ON AT REST, which is the PRODUCT DEFAULT and not the contrarian value the line above is. See
  // {@link ConsentState.autoUnsubscribe}: this flag decides whether a consequence is stated, never
  // whether it happens, so the safe resting value is the one that describes what the server does.
  autoUnsubscribe: true,
  blockAutoUnsubscribeAt: null,
  // OFF AT REST — the feature is disabled by default by design, and off is the safe direction:
  // a tab that does not know renders the pre-feature rail, which is what every account without
  // the flag has.
  foldersEnabled: false,
  foldersEnabledAt: null,
  // NO EXCEPTIONS AT REST — with the master off nothing renders either way, and the pane is
  // gated on `known`, so the resting value is never a switch somebody sees.
  folderMailboxesOff: {},
  folderMailboxesKnown: false,
  // NO SIGNATURES AT REST — and `signaturesKnown: false` is what keeps that from being read as
  // "none": a compose surface must not claim the account signs with nothing before the wire
  // has said so.
  signatures: {},
  // NO MARKUP AT REST, on `signatures`' reasoning and gated by the same flag.
  signaturesHtml: {},
  signaturesKnown: false,
  // NOTHING FROM AN ACCOUNT. Unlike `blockRemoteImages` above, resting null is not a safe
  // *position* — it is the absence of one, and it leaves the language this device remembered in
  // charge. See {@link ConsentState.locale}.
  locale: null,
  // NOTHING FROM AN ACCOUNT — `locale`'s reasoning verbatim: null is the absence of a position
  // and leaves the device's own resolution in charge.
  themeFace: null,
  themeFaceKnown: false,
  known: false,
  standalone: false,
  cloudClient: false,
  foldersStorable: false,
  // NEVER BEEN THROUGH SETUP, at rest. Not a safe position — see
  // {@link ConsentState.onboardingCompletedAt}: it is the value that would OPEN a setup dialog,
  // which is why the mount site gates on `known` as well and never on this alone.
  onboardingCompletedAt: null,
  // WINDOWED AT REST — the behaviour every build had before the mode existed, so an API too old
  // to carry it and a failed read land on exactly what that server actually does.
  screeningScope: "window",
};

/** The `boot-cache.ts` scope this hook owns. Exported for the sign-out test and nothing else. */
export const CONSENT_BOOT_SCOPE = "consent";

/**
 * What may be cached for the next boot, and the boundary that decides it: the three fields the
 * boot render cannot be honest without — the two halves of the cutline arithmetic
 * (`dormancyDays`, `screeningBaselineAt`) and `seedConfirmedAt` (`known: true` with a null seed
 * would flash the seed review at an account that confirmed it long ago). Deliberately NOT here:
 * `autoSuggest` (a cached true could spend credits revoked in another session) and
 * `blockRemoteImages` (a cached "images load" could fetch a sender's content for somebody who
 * opted out elsewhere) — both keep their safe resting values until the live answer.
 * `test/consent-boot-cache.test.tsx` watches this boundary.
 */
interface ConsentBootCache {
  v: 1;
  seedConfirmedAt: string | null;
  dormancyDays: number;
  screeningBaselineAt: string | null;
  /**
   * "Use folders", cached so the rail does not flash folderless on every warm boot of a
   * folders-on account. INSIDE the authorisation boundary deliberately: the flag authorises no
   * spend, no send and no content fetch — it gates chrome over data the mirror already holds.
   * Absent from an older build's row ⇒ off until the live answer, exactly a no-cache boot.
   */
  foldersEnabledAt?: string | null;
}

/**
 * A cache row an older or foreign build wrote must degrade to "no cache", never to a value of
 * the wrong type: `dormancyDays` reaches date arithmetic and the other two reach `Date.parse`.
 */
function acceptConsentCache(parsed: unknown): ConsentBootCache | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.dormancyDays !== "number" || !Number.isFinite(p.dormancyDays)) return null;
  if (p.seedConfirmedAt !== null && typeof p.seedConfirmedAt !== "string") return null;
  if (p.screeningBaselineAt !== null && typeof p.screeningBaselineAt !== "string") return null;
  // Optional and tolerant: a row written before the field existed reads as "off until the live
  // answer", which is the same boot a tab with no cache has always had.
  const foldersEnabledAt =
    typeof p.foldersEnabledAt === "string" ? p.foldersEnabledAt : null;
  return {
    v: 1,
    seedConfirmedAt: p.seedConfirmedAt,
    dormancyDays: p.dormancyDays,
    screeningBaselineAt: p.screeningBaselineAt,
    foldersEnabledAt,
  };
}

/**
 * @param active `false` on the demo. Keeps {@link RESTING}, which is the same window the engine
 * would have used unasked.
 * @param transport A host's own wire — the desktop on its HOSTED door. Absent ⇒ the browser's
 * Cloud client, and where that is not configured either (a standalone install) nothing is asked.
 * See {@link ConsentTransport}. It must be a STABLE value — a module constant, as
 * `awayOverBridge` is — or, strictly, it must not change identity in a way the caller depends on:
 * the effect below reads it through a ref and re-runs only on `active`/reachability, so a fresh
 * object each render costs nothing but a mid-flight swap is not honoured until one of those moves.
 */
export function useConsentState(
  active: boolean,
  transport?: ConsentTransport,
  /**
   * The settings stamp from the sync channel — the `settings` entity's `updatedAt` as the mirror
   * holds it, or null. Every consent-settings write appends a `settings` change row in the same
   * transaction (`consent-seed.ts`), so a CHANGED stamp means "the account's settings moved
   * somewhere; re-ask". The hook re-runs `GET /consent` per stamp transition — the authority
   * stays the live read; the mirror record is a doorbell, never a second consent answer — guarded
   * so a write from THIS tab outranks a re-ask in flight and an older answer never lands over a
   * newer one. The FIRST observed stamp also re-asks once (a write can land between boot read and
   * first drain). One small GET per session.
   */
  settingsStamp?: string | null,
): ConsentState & {
  /**
   * "Apply for all devices" — store the account-wide face and keep the local answer in step
   * with the stored echo. NULL when the transport predates the knob (the desktop's hosted
   * door): the settings row withholds the affordance structurally rather than drawing a
   * control that cannot control. Rethrows on refusal, like every sibling.
   */
  setThemeFace: ((themeFace: "paper" | "ohmarchy" | null) => Promise<"paper" | "ohmarchy" | null>) | null;
  /**
   * Flip auto-suggest and keep the local answer in step with the stored one.
   *
   * Resolves to what the DATABASE holds, and the local state is set from that rather than from
   * the argument — so a refused write leaves the flag showing its real value instead of the one
   * the click hoped for. It rethrows, because a settings toggle that silently did nothing is the
   * failure the caller has to be able to tell the user about.
   */
  setAutoSuggest: (enabled: boolean) => Promise<boolean>;
  /**
   * Move the dormancy dial and keep the local window in step with the stored one. Resolves to
   * the EFFECTIVE window the server counted with, and `state.dormancyDays` is set from that
   * echo, not the argument — so passing the product default (stored as NULL) leaves the state
   * showing the real number, and a refused write is never mistaken for a move. The control MUST
   * write through here rather than `consentApi` directly: the partition memo is keyed on
   * `consent.dormancyDays`, so the echo re-partitions the same render — a component with its
   * own fetch leaves the open tab counting with the stale window.
   */
  setDormancyDays: (
    days: number | null | undefined, scope?: "window" | "all_time",
  ) => Promise<number>;
  /**
   * Keep the per-message "Show images" flow, or let images load, and keep the local answer in step
   * with the stored one.
   *
   * Resolves to what the DATABASE holds, set from the echo rather than from the argument, for the
   * same reason as the two above and one sharper one: a write that FAILED must never leave this
   * tab believing images may load. It rethrows so the caller can say so.
   */
  setBlockRemoteImages: (blocked: boolean) => Promise<boolean>;
  /**
   * Keep refusing tracking pixels (the default), or let them load with the pictures, and keep the
   * local answer in step with the stored one. Resolves to `blockTrackingPixels` AS THE DATABASE
   * HOLDS IT — set from the echo, never the argument, for the reason the row above gives with the
   * sign reversed: a write that FAILED must never leave this tab believing a beacon may load.
   */
  setBlockTrackingPixels: (blocked: boolean) => Promise<boolean>;
  /**
   * Stop auto-unsubscribe on screen-out, or let it run, and keep the local
   * answer in step with the stored one. Resolves to `autoUnsubscribe` AS
   * THE DATABASE HOLDS IT — the argument is the opt-out, the answer is the
   * feature, inverted exactly once at this seam. Set from the echo for the
   * reasons above, the sharper half being a write that FAILED while turning
   * it off: a tab drawing the switch as off would tell somebody their lists
   * are safe while every screen-out goes on leaving one. It rethrows so the
   * row can say the write did not land.
   */
  setBlockAutoUnsubscribe: (blocked: boolean) => Promise<boolean>;
  /**
   * Turn "Use folders" on or off and keep the local answer in step with the stored one.
   *
   * Resolves to what the DATABASE holds, set from the echo rather than the argument — a refused
   * write must not draw a rail the account does not have. It rethrows so the row can say so.
   */
  setFoldersEnabled: (enabled: boolean) => Promise<boolean>;
  /**
   * Switch ONE mailbox's folders on or off under the master toggle (FOLDERS-SPEC.md §17).
   * Resolves to the whole exceptions map as the DATABASE holds it — the echo, never the
   * argument — and rethrows on refusal so the row can say so.
   */
  setMailboxFoldersEnabled: (mailboxId: string, enabled: boolean) => Promise<Record<string, string>>;
  /**
   * Store or clear ONE mailbox's signature (mail 0075). Resolves to the whole signatures map
   * as the DATABASE holds it — the echo, never the argument, because the editor renders
   * server-confirmed text only — and rethrows on refusal so the pane can say the write did
   * not land.
   */
  setMailboxSignature: (
    mailboxId: string, signature: string | null, signatureHtml?: string | null,
  ) => Promise<Record<string, string>>;
} {
  const [state, setState] = useState<ConsentState>(RESTING);
  /**
   * The LAST CACHE ROW this hook wrote or adopted, so a same-tab settings write can update the
   * device's copy WITHOUT re-deriving the other fields from state mid-callback. Without this,
   * a toggle updated React state alone and the next boot painted the PREVIOUS answer until
   * `GET /consent` landed — or for ever, if that read failed: disabling folders on a
   * folders-on account could resurrect the rail from cache. Null until a cache row exists
   * (first visit, desktop), in which case there is nothing stale to correct.
   */
  const bootCache = useRef<ConsentBootCache | null>(null);

  /* IS THERE ANYWHERE TO ASK — the host's wire, or the browser's. One answer, read by the fetch
     below, by all four writers, and by `standalone`, so those six can never disagree about
     whether this account has a stored row. */
  const reachable = transport !== undefined || apiConfigured();
  /* The wire behind a stable identity, so the effect's dependencies stay `[active, reachable]` and
     a host that builds its transport inline does not refetch on every render. The same `link` ref
     `screener-suggest.ts` keeps around its own wire, for the same reason. */
  const link = useRef<ConsentTransport>(transport ?? CLOUD_CONSENT);
  link.current = transport ?? CLOUD_CONSENT;

  /**
   * THE RE-ASK GUARDS — the mobile coordinator's semantics, in three refs:
   *
   *  · `writeEpoch` bumps BEFORE every setter's PATCH, so any read captured earlier is discarded
   *    whatever it answers — the user's act outranks every read in flight (the measured race:
   *    a boot GET resolving after a PATCH reset the switch to the pre-write value);
   *  · `readSeq`/`appliedSeq` order overlapping reads by ISSUE and let only a newer VALID answer
   *    apply — an older response arriving last must not overwrite the fresher one, and a newer
   *    read that FAILS invalidates nothing (a failure is not an answer).
   */
  const writeEpoch = useRef(0);
  const readSeq = useRef(0);
  const appliedSeq = useRef(0);
  /**
   * THE LIFECYCLE ERA — bumped when the boot effect re-arms AND on its cleanup, so a read still
   * in the air when the hook DEACTIVATES (the live→demo transition, an unmount) applies nothing
   * and writes no cache. The old inline effect had a `live` flag doing exactly this; the shared
   * `fetchLive` lost it in the extraction and a late response could install account state into
   * an inactive shell (review-caught). Epoch/seq guard the WRITE races; this guards the
   * hook's own lifetime.
   */
  const era = useRef(0);

  const fetchLive = useCallback(async (): Promise<void> => {
    const at = writeEpoch.current;
    const eraAt = era.current;
    const mine = ++readSeq.current;
    try {
        const wire: ConsentStateWire = await link.current.state();
        // A write from this tab outranks every read in flight; a newer applied read outranks an
        // older one arriving late; and a read outliving the hook's active era — deactivated,
        // unmounted — is nobody's answer. Issuance alone supersedes nothing — see the refs above.
        if (era.current !== eraAt || writeEpoch.current !== at || mine <= appliedSeq.current) return;
        // KNOWN MEANS THE SERVER ANSWERED THIS QUESTION, not that a request returned 200.
        //
        // The window is the one field that cannot be absent from a real answer — the route
        // substitutes the product default rather than ever sending null — so its presence and
        // its type ARE the check. A body that does not carry one is a stale deployment, a
        // proxy that rewrote it, or a harness answering every url alike, and none of those
        // are grounds to re-present somebody's whole mailbox. `known: false` leaves every
        // message in the pile its folder names, which is the safe direction.
        if (typeof wire.dormancyDays !== "number" || !Number.isFinite(wire.dormancyDays)) return;
        setState({
          // Normalised: absent and null both mean "nobody has answered the review yet".
          seedConfirmedAt: wire.seedConfirmedAt ?? null,
          dormancyDays: wire.dormancyDays,
          // `?? null` — BOTH null and undefined, and here they really are the same answer. Null
          // is a server that read the row and found no baseline; undefined is an API from before
          // mail 0056. Neither carries one, both partition with the sliding window, and neither
          // may be turned into an instant. This is the SAME read that carries `dormancyDays`, so
          // the two halves of the cutoff can never come from different fetches.
          screeningBaselineAt: wire.screeningBaselineAt ?? null,
          activeUndecidedSenders: wire.counts?.activeUndecidedSenders ?? 0,
          // `== null` covers BOTH null (off) and undefined (an API from before mail 0040).
          // Written as one comparison because the two are the same answer to the only question
          // asked of this field, and splitting them would invite a branch where one of them
          // becomes true.
          autoSuggest: wire.autoSuggestAt != null,
          // Normalised to null so `undefined` (an API from before mail 0040) cannot reach a view.
          autoSuggestAt: wire.autoSuggestAt ?? null,
          // `=== undefined` and NOT `== null`, which is the opposite of the line four above it and
          // is the whole point. `null` means the server read the row and found no opt-out ⇒ images
          // load. `undefined` means this API predates mail 0048 and never looked ⇒ keep the button.
          // Writing this as `!= null` would collapse the two and load remote content on behalf of
          // an account whose stored preference this build cannot see.
          blockRemoteImages: wire.blockRemoteImagesAt === undefined
            ? true
            : wire.blockRemoteImagesAt !== null,
          blockRemoteImagesAt: wire.blockRemoteImagesAt ?? null,
          // `== null` — BOTH null and undefined — and deliberately NOT the `=== undefined` split the
          // images field above needs. There the two answers differ because only one of them may
          // load a sender's content. Here they are the same answer: a server that found no opt-out
          // and a server too old to have looked both leave pixels BLOCKED, which is the protective
          // posture, so a garbled or elderly wire can only ever refuse a beacon, never fetch one.
          blockTrackingPixels: wire.loadTrackingPixelsAt == null,
          loadTrackingPixelsAt: wire.loadTrackingPixelsAt ?? null,
          // `== null` — BOTH null and undefined — which is the line four above's shape and NOT the
          // one directly above it, and the difference is deliberate in both places. For images the
          // two are different answers because only one of them may load a sender's content. Here
          // they are the same answer: neither carries a stored opt-out, so in both cases the
          // server is going to unsubscribe and the interface has to say so.
          autoUnsubscribe: wire.blockAutoUnsubscribeAt == null,
          blockAutoUnsubscribeAt: wire.blockAutoUnsubscribeAt ?? null,
          // `!= null` — null (off) and undefined (an API from before the folders feature) are
          // the same answer to the only question asked: is there a stored opt-in. Off renders
          // the pre-feature interface, which is what such a server serves anyway.
          foldersEnabled: wire.foldersEnabledAt != null,
          foldersEnabledAt: wire.foldersEnabledAt ?? null,
          // Absent (an API before mail 0073) reads as "no exceptions" — the picture that
          // server actually serves, since it filters nothing per mailbox.
          folderMailboxesOff: wire.folderMailboxesOff ?? {},
          // The LIVE answer, whatever it holds — an older API's absent map is a real "no
          // exceptions", so the switches may render over it.
          folderMailboxesKnown: true,
          // Absent (an API before mail 0075) reads as "no signatures" — the picture that server
          // actually serves, since nothing on it can store one.
          signatures: wire.signatures ?? {},
          // Absent (an API before mail 0098) reads as "no signature has formatting" — again the
          // picture that server serves, since nothing on it can store markup.
          signaturesHtml: wire.signaturesHtml ?? {},
          signaturesKnown: true,
          // NORMALISED, not trusted. The column's CHECK and `consentSettings` both close the set,
          // so an unsupported string cannot arrive from a current server — and this is the boot
          // path, where a value that got through would make the client ask for a catalogue that
          // does not exist. `normalizeLocale` answers null for anything it does not recognise,
          // which lands on exactly the same branch as "this account has no preference".
          locale: normalizeLocale(wire.locale),
          // NORMALISED, not trusted — `locale`'s rule: the CHECK and the read-side filter close
          // the set on the server, and anything else collapses to "no account-wide choice".
          themeFace: wire.themeFace === "paper" || wire.themeFace === "ohmarchy"
            ? wire.themeFace
            : null,
          themeFaceKnown: true,
          // Absent and null are ONE answer: an API from before mail 0083 cannot say, and a
          // server that read the row and found no stamp says the same thing about the account —
          // nobody has finished or cancelled setup. Both leave the flow eligible to open, which
          // is only reachable at all once `known` is true one line above.
          onboardingCompletedAt: wire.onboardingCompletedAt ?? null,
          // NORMALISED, not trusted — `locale`'s rule: the column's CHECK and `consentSettings`
          // both close the set, and anything else is a server this build does not understand,
          // which must land on the pre-mode behaviour rather than on an unknown partition.
          screeningScope: wire.screeningScope === "all_time" ? "all_time" : "window",
          known: true,
          // Both of these are DERIVED on the way out (see the return) and are written here only
          // because the state object carries them. Nothing may read them off `state`.
          standalone: false,
          cloudClient: false,
          foldersStorable: false,
        });
        appliedSeq.current = mine;
        // The next boot paints from THIS answer. Written after the state (never instead of
        // it), from the same normalised values, under the same account id the read used —
        // and only the three fields `ConsentBootCache` names, which is the authorisation
        // boundary, not an economy.
        const owner = readOwner();
        if (owner !== null) {
          const next: ConsentBootCache = {
            v: 1,
            seedConfirmedAt: wire.seedConfirmedAt ?? null,
            dormancyDays: wire.dormancyDays,
            screeningBaselineAt: wire.screeningBaselineAt ?? null,
            foldersEnabledAt: wire.foldersEnabledAt ?? null,
          };
          writeBootCache(CONSENT_BOOT_SCOPE, owner, next);
          bootCache.current = next;
        }
      } catch {
        // Deliberately silent — see the header.
      }
  }, []);

  useEffect(() => {
    if (!active || !reachable) {
      /**
       * No wire ⇒ resting values — enforced, not merely documented (`local-consent.ts` states
       * the rule for a failed read; this is the same rule for a wire that is GONE). The
       * desktop's door chooser is an overlay over the mounted shell, so a cloud→local switch
       * can land here with the hosted account's answers still in state — a folders rail or
       * spending switch rendered from a departed account's row over a standalone engine would
       * refuse every verb (review-caught). A read in flight from the old wire is already dead
       * (the era cleanup ran when `reachable` moved). setState with the RESTING constant is a
       * React bailout when the state never left it.
       */
      if (active && !reachable) {
        bootCache.current = null;
        setState(RESTING);
      }
      return;
    }
    /**
     * The device's last answer, first — synchronously, before the fetch is issued, so the live
     * answer can only land on top of the cache, never under it. Keyed by the remembered account
     * id (`owner-cookie.ts`) — the same id that names the mirror the warm open paints from, so
     * the cached window and the cached mail describe the same account. No cookie (first visit,
     * desktop) ⇒ no cache; the boot waits for the server as before. The `prev.known` guard
     * makes "the fetch already answered" win unconditionally; unreachable with the synchronous
     * read above, kept because that is an ordering fact of this effect's body.
     */
    const owner = readOwner();
    if (owner !== null) {
      const cached = readBootCache(CONSENT_BOOT_SCOPE, owner, acceptConsentCache);
      if (cached !== null) {
        bootCache.current = cached;
        setState((prev) =>
          prev.known
            ? prev
            : {
                ...prev,
                seedConfirmedAt: cached.seedConfirmedAt,
                dormancyDays: cached.dormancyDays,
                screeningBaselineAt: cached.screeningBaselineAt,
                foldersEnabled: (cached.foldersEnabledAt ?? null) != null,
                foldersEnabledAt: cached.foldersEnabledAt ?? null,
                known: true,
              },
        );
      }
    }
    void fetchLive();
    // The cleanup closes this era: a response landing after deactivation or unmount applies
    // nothing — see `era` above.
    return () => { era.current += 1; };
    // The fetch itself lives in `fetchLive` below so the settings-stamp effect can share it —
    // one implementation of "read the live answer and apply it under the guards".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, reachable, fetchLive]);


  /**
   * THE SETTINGS-STAMP RE-ASK — the sync channel's doorbell, answered with the live read.
   *
   * Fires on every observed TRANSITION of the stamp, including the first observation (see the
   * parameter's own note for why the baseline is not skipped). `fetchLive`'s guards make the
   * re-ask safe against this tab's own writes and against overlapping reads.
   */
  const seenStamp = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !reachable) return;
    if (settingsStamp == null) return;
    if (seenStamp.current === settingsStamp) return;
    seenStamp.current = settingsStamp;
    void fetchLive();
  }, [active, reachable, settingsStamp, fetchLive]);

  /**
   * A write's echo applies only in the era it was issued in — the setters' half of the
   * wire-loss rule. The desktop bridge lets an in-flight request finish against a replaced
   * engine, so a hosted PATCH can resolve AFTER the switch to the standalone door; applied
   * unconditionally, its echo would resurrect the departed account's answers (review-caught,
   * round 3). `era` moves on exactly the transitions that change worlds — the boot effect's
   * cleanup — so a same-world write always lands and a cross-world one never does. The setter
   * still RESOLVES with the echo (the write happened, on the account it was issued against).
   */
  const applyEcho = useCallback(
    (at: number, updater: (prev: ConsentState) => ConsentState): void => {
      if (era.current === at) setState(updater);
    },
    [],
  );

  /**
   * "APPLY FOR ALL DEVICES" — the account-wide face write. `null` when the transport cannot
   * store one, so the settings row can withhold the affordance structurally instead of drawing a
   * control that cannot control. Echo-not-the-argument and the era rule, exactly as every
   * sibling below. (Both shipping transports carry the knob now — the Cloud client, and the
   * desktop's hosted door over the bridge; the gate stays because a host that cannot reach an
   * account row must not be handed an account-wide control.)
   */
  const writeThemeFace = useCallback(
    async (themeFace: "paper" | "ohmarchy" | null): Promise<"paper" | "ohmarchy" | null> => {
      // Read off `link` AT CALL TIME, like every sibling — the ref is refreshed each render, so
      // a host that swaps transports (the desktop's door switch) is never written through a
      // stale wire. A call reaching here without the method is a caller that ignored the
      // null gate below; refusing beats silently "succeeding".
      const write = link.current.setThemeFace;
      if (!write) throw new Error("this transport cannot store an account-wide face");
      // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
      // request, so a re-ask racing this write is discarded whatever it answers.
      writeEpoch.current += 1;
      const at = era.current;
      const res = await write(themeFace);
      const stored = res.themeFace === "paper" || res.themeFace === "ohmarchy" ? res.themeFace : null;
      applyEcho(at, (prev) => ({ ...prev, themeFace: stored, themeFaceKnown: true }));
      return stored;
    },
    [applyEcho],
  );
  // Null when the transport cannot store an account-wide face, so the settings row withholds the
  // "apply for all devices" affordance structurally — a control that cannot control is the
  // built-and-unreachable shape the injected-node seam exists to avoid. A STANDALONE desktop
  // window passes no transport at all and keeps only the device pin, which is the whole of the
  // appearance choice a machine with no account row can make.
  const setThemeFace =
    typeof (transport ?? CLOUD_CONSENT).setThemeFace === "function" ? writeThemeFace : null;

  const setAutoSuggest = useCallback(async (enabled: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const at = era.current;
    const res = await link.current.setAutoSuggest(enabled);
    const on = res.autoSuggestAt != null;
    // BOTH FIELDS FROM THE SAME ECHO. Setting the boolean from the server and the instant from
    // the argument (or leaving it stale) is how a row reads "On since <yesterday>" about a write
    // that was refused — the two must move together or not at all.
    applyEcho(at, (prev) => ({ ...prev, autoSuggest: on, autoSuggestAt: res.autoSuggestAt ?? null }));
    return on;
  }, [applyEcho]);

  const setDormancyDays = useCallback(async (
    days: number | null | undefined, scope?: "window" | "all_time",
  ): Promise<number> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const at = era.current;
    const res = await link.current.setDormancyDays(days, scope);
    // FROM THE SERVER ECHO, never the argument — the server stores the default as NULL and reads it
    // back as the default number, so this is the window the partition memo must re-key on.
    //
    // EACH HALF ONLY IF THE ECHO CARRIES IT. The route answers with what it acted on, so a call
    // that named only the mode returns no window: folding an absent one in as `undefined` would
    // blank the dial the pane renders, and folding it in as the default would show a window the
    // account does not have. Absent means "unchanged", exactly as it does on the wire.
    /* THE EFFECTIVE WINDOW IS READ OUT OF THE FOLD, never fabricated after it.
       A mode-only write ("all time") names no window, so the route correctly echoes none — and a
       `?? DEFAULT_DORMANCY_DAYS` here would answer 60 about an account holding 180, which is a
       number this function invented. The true answer is the one the state ends the fold with: the
       echo's window when there was one, and the untouched stored window when there was not.
       Captured from inside the updater because that is the only place the previous state is in
       scope without making this callback re-identify on every window change. */
    let effective: number | undefined;
    applyEcho(at, (prev) => {
      const next = {
        ...prev,
        ...(res.dormancyDays !== undefined ? { dormancyDays: res.dormancyDays } : {}),
        ...(res.screeningScope !== undefined ? { screeningScope: res.screeningScope } : {}),
      };
      effective = next.dormancyDays;
      return next;
    });
    // `applyEcho` DROPS a fold whose era is stale, so the updater may never run. Then this write
    // is not the one describing the account any more and the echo is the only thing it may report.
    return effective ?? res.dormancyDays ?? DEFAULT_DORMANCY_DAYS;
  }, [applyEcho]);

  const setBlockRemoteImages = useCallback(async (blocked: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const at = era.current;
    const res = await link.current.setBlockRemoteImages(blocked);
    const on = res.blockRemoteImagesAt != null;
    // BOTH FIELDS FROM THE SAME ECHO, as with auto-suggest — a row reading "Off since <yesterday>"
    // about a refused write is the failure that rule exists to prevent, and here the refused write
    // is the one that would start loading a sender's images.
    applyEcho(at, (prev) => ({ ...prev, blockRemoteImages: on, blockRemoteImagesAt: res.blockRemoteImagesAt ?? null }));
    return on;
  }, [applyEcho]);

  const setBlockTrackingPixels = useCallback(async (blocked: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const at = era.current;
    const res = await link.current.setBlockTrackingPixels(blocked);
    // The echo is the OPT-OUT instant; the flag is its absence. Inverted exactly once, here.
    const on = res.loadTrackingPixelsAt == null;
    applyEcho(at, (prev) => ({
      ...prev, blockTrackingPixels: on, loadTrackingPixelsAt: res.loadTrackingPixelsAt ?? null,
    }));
    return on;
  }, [applyEcho]);

  const setFoldersEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const at = era.current;
    const res = await link.current.setFoldersEnabled(enabled);
    const on = res.foldersEnabledAt != null;
    // BOTH FIELDS FROM THE SAME ECHO — auto-suggest's rule: the boolean the shell gates on and
    // the instant the row displays must move together or not at all.
    applyEcho(at, (prev) => ({ ...prev, foldersEnabled: on, foldersEnabledAt: res.foldersEnabledAt ?? null }));
    // …AND THE DEVICE'S CACHED COPY MOVES WITH THEM. The boot cache paints the next reload's
    // first frame; leaving it at the pre-toggle answer would resurrect a rail the account just
    // turned off (or hide one it turned on) until — or unless — the live read lands. Only when
    // a cache row exists: no row means no stale copy to correct, and inventing one here would
    // cache partition inputs this tab never confirmed. Era-guarded like the state echo — a
    // cross-world completion must not write the departed account's flag into this device's
    // cache either.
    const owner = readOwner();
    if (era.current === at && owner !== null && bootCache.current !== null) {
      const next: ConsentBootCache = { ...bootCache.current, foldersEnabledAt: res.foldersEnabledAt ?? null };
      writeBootCache(CONSENT_BOOT_SCOPE, owner, next);
      bootCache.current = next;
    }
    return on;
  }, [applyEcho]);

  const setMailboxFoldersEnabled = useCallback(
    async (mailboxId: string, enabled: boolean): Promise<Record<string, string>> => {
      // The user's act outranks every read in flight — see `writeEpoch`.
      writeEpoch.current += 1;
      const at = era.current;
      const res = await link.current.setMailboxFoldersEnabled(mailboxId, enabled);
      const off = res.folderMailboxesOff ?? {};
      // THE WHOLE MAP FROM THE ECHO — the server answers with every exception after the write,
      // so a stale tab that missed another device's toggle heals on its own next write.
      applyEcho(at, (prev) => ({ ...prev, folderMailboxesOff: off, folderMailboxesKnown: true }));
      return off;
    }, [applyEcho]);

  const setMailboxSignature = useCallback(
    async (
      mailboxId: string, signature: string | null, signatureHtml?: string | null,
    ): Promise<Record<string, string>> => {
      // The user's act outranks every read in flight — see `writeEpoch`.
      writeEpoch.current += 1;
      const at = era.current;
      const res = await link.current.setMailboxSignature(mailboxId, signature, signatureHtml);
      const map = res.signatures ?? {};
      // BOTH MAPS FROM THE ECHO — the exceptions dial's rule, and it has to cover both halves
      // because a write to EITHER changes both columns: saving markup derives the text, and
      // saving text clears the markup. Storing only the map that was posted would leave the pane
      // and every open composer rendering a stale half.
      const htmlMap = res.signaturesHtml ?? {};
      applyEcho(at, (prev) => ({
        ...prev, signatures: map, signaturesHtml: htmlMap, signaturesKnown: true,
      }));
      return map;
    }, [applyEcho]);

  const setBlockAutoUnsubscribe = useCallback(async (blocked: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const at = era.current;
    const res = await link.current.setBlockAutoUnsubscribe(blocked);
    // `== null` ⇒ the pass runs. The same collapse as the read above, for the same reason, and it
    // has to be spelled the same way in both places or a server that answered with the field
    // omitted would move the switch one way on load and the other on write.
    const on = res.blockAutoUnsubscribeAt == null;
    applyEcho(at, (prev) => ({
      ...prev,
      autoUnsubscribe: on,
      blockAutoUnsubscribeAt: res.blockAutoUnsubscribeAt ?? null,
    }));
    return on;
  }, [applyEcho]);

  // Derived rather than stored, so neither can be left behind by a setState
  // that forgot it: both are facts about the BUILD and the mode, settled before first render (`active` is `!demo`; see
  // {@link ConsentState.standalone} and {@link ConsentState.cloudClient}).
  // Presented, not stored: with no wire, the ANSWER is the resting values —
  // synchronously, in the same render that observes the wire gone. The
  // reset effect runs after paint, so on the overlay door switch the commit
  // between "reachable flipped" and "the effect fired" would present the
  // departed account's rail for one frame (review-caught, round 3). The
  // effect keeps its job — clearing the STORED state so a later hosted
  // re-entry cannot open on the stale answer.
  const presented = active && !reachable ? RESTING : state;
  return {
    ...presented,
    standalone: active && !reachable,
    cloudClient: apiConfigured(),
    /* From the WIRE, so it answers for the transport actually in use rather than for the one this
       build would fall back to — and only while a wire is reachable at all: with none, the pane it
       gates is already withheld by `known`, and claiming a capability for a server nobody is
       talking to would be a second answer to a question that has none. */
    foldersStorable: reachable && link.current.foldersStorable,
    setThemeFace,
    setAutoSuggest,
    setDormancyDays,
    setBlockRemoteImages,
    setBlockTrackingPixels,
    setBlockAutoUnsubscribe,
    setFoldersEnabled,
    setMailboxFoldersEnabled,
    setMailboxSignature,
  };
}
