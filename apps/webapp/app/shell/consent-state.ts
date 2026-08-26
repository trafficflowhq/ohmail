"use client";

/**
 * WHERE THIS ACCOUNT STANDS IN ONBOARDING, and the dormancy window it is counted with.
 *
 * One `GET /consent` per tab. Everything the shell needs from it is a scalar: has the seed
 * review been confirmed, and how many days of quiet make a sender dormant.
 *
 * ── WHY THE DIAL COMES OVER REST AND NOT THROUGH `/sync` ─────────────────────────────────
 *
 * The mirror carries mail. A per-account integer with no history and no delete is not a
 * change to mail, and giving it an entity type would grow the change-log writers, the wire
 * union and the mirror's vocabulary for a value that moves once a year. The schema already
 * documents this shape for per-account settings tables — REST, and the client refetches.
 *
 * The accepted cost is stated rather than hidden: a second tab that is open while the dial
 * moves keeps partitioning with the old window until it reloads. The window decides which
 * senders are ASKED about, not what is stored or searchable, so the worst case is a Screener
 * queue that is briefly the wrong length in one tab.
 *
 * ── THE BOOT READS THE DEVICE'S COPY OF THE LAST ANSWER FIRST ────────────────────────────
 *
 * The warm open paints the mirror in the first frame, and a partition that waits for this
 * fetch presents the RAW piles for the whole round trip — measured live: every reload
 * resurrected the same set of already-decided Screener senders (their mail physically at the
 * gate, presented elsewhere by their rules) and held them until `GET /consent` answered, however
 * many `/sync` drains completed in between. So the effect below first applies this account's
 * CACHED last answer (`boot-cache.ts` — the three partition inputs and nothing that authorises
 * anything), then lets the live answer overwrite it and the cache both. The staleness this can
 * show is exactly the second-tab cost the paragraph above already accepts.
 *
 * ── AND WHY A FAILURE IS SILENT ──────────────────────────────────────────────────────────
 *
 * The default is the product default, which is what the client engine uses anyway. A tab that
 * could not reach this endpoint partitions exactly as it would have before the endpoint
 * existed — or, when this device holds the account's cached answer, with that answer, which is
 * strictly closer to the account's truth than the default. Either way a network blip must not
 * produce an error anybody has to read.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/client-engine";
import { apiConfigured, consent as consentApi, type ConsentStateWire } from "../api-client";
import { readBootCache, writeBootCache } from "./boot-cache";
import { normalizeLocale, type AppLocale } from "./locale";
import { readOwner } from "./owner-cookie";

/**
 * THE FIVE CALLS THIS HOOK MAKES, GATHERED INTO SOMETHING A HOST CAN HAND IN.
 *
 * The same seam as `AwayResponderRow`'s `AwayTransport` and `screener-suggest`'s `SuggestWire`, and
 * it exists for the identical reason. `apiConfigured()` is FALSE in every desktop build, both doors
 * — `apps/desktop/vite.config.ts` aliases `app/api-client` to a stub whose value exports refuse —
 * so the fetch below never ran there, `known` stayed false for the life of the process, and every
 * control gated on it was withheld: the dormancy dial, the auto-suggest opt-in, auto-unsubscribe.
 * That was right for a STANDALONE install, which has no account and nowhere to store any of it. It
 * was wrong for an install on the HOSTED door, which mirrors a real account: its window cannot open
 * a socket (`connect-src 'none'`), but its mail engine holds the account's session and forwards
 * `/consent` to it with the bearer, so the row that is read and written is the account's own.
 *
 * ONLY THE WIRE IS INJECTED, never the controls — the rule `AwayTransport` states. `autoSuggest` is
 * the one flag in this product that authorises spending, and its echo-not-the-argument discipline,
 * its resting values and the single `setState` every consumer reads are decided above this seam and
 * cannot be varied by supplying one. A second implementation of them would be a second answer to
 * "is auto-suggest on", and the direction that costs money is the one where they disagree.
 *
 * Every method is shaped like `api-client`'s own `consent` object, because that IS the default and a
 * shape adapted for the second caller would be a shape invented for it.
 */
export interface ConsentTransport {
  state: () => Promise<ConsentStateWire>;
  setAutoSuggest: (enabled: boolean) => Promise<{ autoSuggestAt: string | null }>;
  setDormancyDays: (days: number | null) => Promise<{ dormancyDays: number }>;
  setBlockRemoteImages: (blocked: boolean) => Promise<{ blockRemoteImagesAt: string | null }>;
  setBlockTrackingPixels: (blocked: boolean) => Promise<{ loadTrackingPixelsAt: string | null }>;
  setBlockAutoUnsubscribe: (blocked: boolean) => Promise<{ blockAutoUnsubscribeAt: string | null }>;
  setFoldersEnabled: (enabled: boolean) => Promise<{ foldersEnabledAt: string | null }>;
  setMailboxFoldersEnabled: (
    mailboxId: string, enabled: boolean,
  ) => Promise<{ folderMailboxesOff: Record<string, string> }>;
}

/** The hosted transport — the browser talking to the API this app was written against. */
const CLOUD_CONSENT: ConsentTransport = {
  state: () => consentApi.state(),
  setAutoSuggest: (enabled) => consentApi.setAutoSuggest(enabled),
  setDormancyDays: (days) => consentApi.setDormancyDays(days),
  setBlockRemoteImages: (blocked) => consentApi.setBlockRemoteImages(blocked),
  setBlockTrackingPixels: (blocked) => consentApi.setBlockTrackingPixels(blocked),
  setBlockAutoUnsubscribe: (blocked) => consentApi.setBlockAutoUnsubscribe(blocked),
  setFoldersEnabled: (enabled) => consentApi.setFoldersEnabled(enabled),
  setMailboxFoldersEnabled: (mailboxId, enabled) =>
    consentApi.setMailboxFoldersEnabled(mailboxId, enabled),
};

export interface ConsentState {
  /** Null until the seed review has been confirmed. Drives which onboarding step is shown. */
  seedConfirmedAt: string | null;
  /** ALWAYS a number, so a partition can always be computed. */
  dormancyDays: number;
  /**
   * WHEN THIS ACCOUNT FINISHED SCREENING ITS BACKLOG, or null for "measure from now".
   *
   * The second half of the cutline arithmetic, and the one field on this object that is NOT
   * normalised to a usable value the way {@link dormancyDays} is. Null has to reach
   * `consentPartition` as null: it selects the pre-baseline behaviour (the sliding window, unread
   * outranking age), and substituting `now` here would silently apply the NARROWED rule to an
   * account that never established a baseline — which drops every undecided sender whose newest
   * mail is older than the window straight into History.
   *
   * Resting null, and so is a failed fetch, an API too old to carry the field, and a standalone
   * install. All four mean "no baseline from an account", all four keep today's partition, and
   * there is no direction here in which not knowing is dangerous — the worst case is the sliding
   * window this field exists to replace.
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
   * DOES THIS ACCOUNT KEEP THE PER-MESSAGE "SHOW IMAGES" FLOW? True = manual, the old behaviour.
   * False = the product default: a message's remote images load through the proxy on open.
   *
   * **It starts TRUE, and that direction is the opposite of every other flag on this object and
   * is deliberate.** {@link autoSuggest} starts false because ON authorises spending, so "I do not
   * know" must not buy anything. Here the dangerous direction is reversed: "I do not know" must
   * not LOAD anything, because the account may have opted out and this build cannot see it. So a
   * failed `GET /consent`, an API too old to carry the field, and a build with no API at all
   * (`apiConfigured()` false — the desktop) all leave this true and keep today's per-message
   * button. Only a successful read that carried `blockRemoteImagesAt: null` moves it to false, and
   * that null is a server saying it read the row and found no opt-out.
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
   * DOES SCREENING A SENDER OUT ALSO UNSUBSCRIBE FROM THEIR LIST? True = the product default.
   *
   * **It starts TRUE, and unlike {@link blockRemoteImages} — the other field whose resting value
   * is not `false` — the safe direction here is the DEFAULT one.** The reason is what the value is
   * used for: nothing on the client sends anything. The server reads its own row and sends or does
   * not; this flag only decides whether the interface SAYS SO before the click and after it. So
   * "I do not know" resolving to false would silently drop the disclosure of an irreversible
   * outbound request that is still happening, which is worse than disclosing one that turns out
   * not to run.
   *
   * A failed `GET /consent`, an API too old to carry the field, and a build with no API at all
   * therefore all leave this true — which is also exactly what the interface did before the switch
   * existed, so no failure mode of this fetch changes what anybody is told.
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
   * THE ACCOUNT'S INTERFACE LANGUAGE, or `null` for "this account has no preference".
   *
   * The one field on this object whose null is a DEFERRAL rather than a switch position, and the
   * only one a consumer must not normalise. `AppShell` adopts a non-null value at boot, overriding
   * whatever language this device had remembered — that is the guard the whole account-tied half of
   * the feature exists for, and it only works if `null` reaches the consumer as null.
   *
   * Resting `null`, and so is a failed fetch, an API too old to carry the field, and a standalone
   * install: all four mean "nothing from an account", and all four correctly leave the device's own
   * choice standing. There is no direction here in which not knowing is dangerous — the worst case
   * is an interface in the language the reader last picked on this machine.
   */
  locale: AppLocale | null;
  /** False until the first answer lands — an onboarding step must not flash before then. */
  known: boolean;
  /**
   * THERE IS NO CONSENT ENDPOINT BEHIND THIS BUILD, AND THERE NEVER WILL BE — the desktop.
   *
   * {@link known} answers "has the server told us the window yet?", and everything gated on it
   * is gated for one reason: partitioning on a GUESSED window would move mail into History on
   * the strength of a default the account may not be using, and a request that merely failed
   * would silently hide somebody's mail. Both halves of that reason presuppose a stored window
   * this client has not yet read.
   *
   * On a standalone install there is no stored window. Nothing can be reached, the fetch never
   * runs, `known` is false for the life of the process — and the shell read that as "the
   * answer has not arrived", switched the cutline off, and drew the Screener over the raw
   * mirror. No History pile at all, and every sender whose mail had already been filed into the
   * Screener folder sat in the queue for ever. `DEFAULT_DORMANCY_DAYS` is not a guess here: it
   * is the only window this build has, the one the engine uses unasked, and the one the dial
   * would have to be turned away from — but there is no dial, because there is nowhere to
   * store the number.
   *
   * ── IT IS "NOTHING TO REACH", NOT "NO CLOUD CLIENT IN THIS BUNDLE" ────────────────────────
   *
   * This used to be exactly `!apiConfigured()`, which made it true of BOTH desktop doors. It is
   * now false wherever a host handed in a {@link ConsentTransport}, because that host has a
   * hosted account behind it and its engine forwards these routes to it — the same widening
   * `awaySupported` makes in `AppShell`, for the same reason and with the same effect on the
   * consumer that matters: `autoUnsubscribeDiscloses` must warn about a request the hosted
   * screener really does make, and must stay silent on the standalone door, which wires no
   * unsubscribe service at all. The standalone door hands in no transport and so stays true.
   *
   * NOT reachable on the web. A live browser tab with no API base never renders this shell at
   * all: `createEngine` throws `EngineUnarmedError` rather than fall back to fixtures. So this
   * is true exactly where an engine was handed in — the desktop's seam — and the known-gate
   * still governs everywhere a server exists.
   *
   * False on the demo, which is `active: false`: the demo is a fixture world with no decisions
   * in it, and `AppShell` refuses to partition it for reasons of its own.
   */
  standalone: boolean;
  /**
   * DOES THIS BUNDLE CARRY THE BROWSER'S CLOUD CLIENT — a fact about the BUILD, and the one
   * question {@link standalone} used to answer before it started answering a better one.
   *
   * Published from here because `AppShell` may not import `app/api-client` at all (it is copied
   * into a published mirror that does not contain the module) and this hook has to read
   * `apiConfigured()` anyway. Two questions now have different answers on the desktop's hosted
   * door and both are needed:
   *
   *  · "is there a server to reach?" — {@link standalone}, transport-aware, and the gate for every
   *    control whose read and write this hook performs;
   *  · "can a hosted CEREMONY run in this window?" — this one. The sent-mail seed review
   *    (`SeedReviewView`) and the remote-image proxy (`shell/remote-images.ts`) call
   *    `app/api-client` DIRECTLY rather than through any injected wire, so no transport makes
   *    them work. False ⇒ the shell must withhold them, or it offers a screen that can only
   *    refuse. See `AppShell`'s `seedOwed`.
   *
   * Not a state field: it is settled before the first render and derived below, so a `setState`
   * cannot leave it behind.
   */
  cloudClient: boolean;
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
  // NOTHING FROM AN ACCOUNT. Unlike `blockRemoteImages` above, resting null is not a safe
  // *position* — it is the absence of one, and it leaves the language this device remembered in
  // charge. See {@link ConsentState.locale}.
  locale: null,
  known: false,
  standalone: false,
  cloudClient: false,
};

/** The `boot-cache.ts` scope this hook owns. Exported for the sign-out test and nothing else. */
export const CONSENT_BOOT_SCOPE = "consent";

/**
 * WHAT MAY BE CACHED FOR THE NEXT BOOT, and the boundary that decides it.
 *
 * The three fields the boot render cannot be honest without: the two halves of the cutline
 * arithmetic (`dormancyDays`, `screeningBaselineAt` — without them `AppShell` presents the raw
 * piles and every reload resurrects the already-decided Screener senders), and
 * `seedConfirmedAt`, because `known: true` with a null seed would flash the seed review at an
 * account that confirmed it long ago.
 *
 * DELIBERATELY NOT HERE, whatever convenience says: `autoSuggest` (a cached true could spend
 * credits the account revoked in another session) and `blockRemoteImages` (a cached "images
 * load" could fetch a sender's content for somebody who opted out elsewhere). Both keep their
 * safe resting values until the live answer — the same values a tab with no cache has always
 * shown for the same interval. `test/consent-boot-cache.test.tsx` watches this boundary.
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
   * THE SETTINGS STAMP FROM THE SYNC CHANNEL — `settings` entity's `updatedAt` as the mirror
   * holds it, or null while the mirror holds no such record. Every consent-settings write on any
   * surface appends a `settings` change row in the same transaction (`consent-seed.ts`), the
   * wake channel rings at its commit, and the next drain lands the row in this client's mirror —
   * so a CHANGED stamp here means "the account's settings moved somewhere; re-ask". The hook
   * re-runs `GET /consent` on every stamp transition (the authority stays the live read — the
   * mirror record is a doorbell, never a second consent answer), guarded so a write from THIS
   * tab always outranks a re-ask in flight, and an older answer never lands over a newer one —
   * the mobile folders-flag coordinator's measured rules, inherited rather than re-learned.
   * The FIRST observed stamp also re-asks once: a settings write can land between the boot read
   * and the first drain, and skipping the baseline would hold that stale boot answer for the
   * session. Costs one small GET per session; correctness over the request.
   */
  settingsStamp?: string | null,
): ConsentState & {
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
   * Move the dormancy dial and keep the local window in step with the stored one.
   *
   * Resolves to the EFFECTIVE window the server counted with, and `state.dormancyDays` is set from
   * THAT echo, not from the argument — so passing the product default (which the server stores as
   * NULL) leaves the state showing the real number, and a refused write is never mistaken for a
   * move. The control MUST write through here rather than calling `consentApi` directly: the memo
   * that partitions the mirror (`consentPartition` in `AppShell`) is keyed on `consent.dormancyDays`,
   * so setting it from the echo re-partitions the same render — a component with its own fetch would
   * leave the open tab counting with the stale window.
   */
  setDormancyDays: (days: number | null) => Promise<number>;
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
   * Stop auto-unsubscribe on screen-out, or let it run, and keep the local answer in step with the
   * stored one.
   *
   * Resolves to `autoUnsubscribe` AS THE DATABASE HOLDS IT — so the argument is the opt-out and
   * the answer is the feature, inverted exactly once at this seam. Set from the echo rather than
   * the argument for the reason the three above give, with the sharper half being the write that
   * FAILED while turning it off: a tab that drew the switch as off would be telling somebody their
   * lists are safe while every screen-out goes on leaving one. It rethrows so the row can say the
   * write did not land.
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
          // NORMALISED, not trusted. The column's CHECK and `consentSettings` both close the set,
          // so an unsupported string cannot arrive from a current server — and this is the boot
          // path, where a value that got through would make the client ask for a catalogue that
          // does not exist. `normalizeLocale` answers null for anything it does not recognise,
          // which lands on exactly the same branch as "this account has no preference".
          locale: normalizeLocale(wire.locale),
          known: true,
          // Both of these are DERIVED on the way out (see the return) and are written here only
          // because the state object carries them. Nothing may read them off `state`.
          standalone: false,
          cloudClient: false,
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
    if (!active || !reachable) return;
    /**
     * THE DEVICE'S LAST ANSWER, FIRST — synchronously, before the fetch below is even issued,
     * so the live answer can only ever land on top of the cache and never under it.
     *
     * Keyed by the remembered account id (`owner-cookie.ts`) — the same id that names the
     * mirror the warm open paints from, so the cached window and the cached mail can only ever
     * describe the same account. No cookie (a first visit, the desktop) ⇒ no cache, and the
     * boot waits for the server exactly as it did before the cache existed.
     *
     * The `prev.known` guard makes "the fetch already answered" unconditionally win; with the
     * synchronous read above it is unreachable, and it is kept because the reachability is an
     * ordering fact of this effect's body, not a property of the state machine.
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

  const setAutoSuggest = useCallback(async (enabled: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const res = await link.current.setAutoSuggest(enabled);
    const on = res.autoSuggestAt != null;
    // BOTH FIELDS FROM THE SAME ECHO. Setting the boolean from the server and the instant from
    // the argument (or leaving it stale) is how a row reads "On since <yesterday>" about a write
    // that was refused — the two must move together or not at all.
    setState((prev) => ({ ...prev, autoSuggest: on, autoSuggestAt: res.autoSuggestAt ?? null }));
    return on;
  }, []);

  const setDormancyDays = useCallback(async (days: number | null): Promise<number> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const res = await link.current.setDormancyDays(days);
    // FROM THE SERVER ECHO, never the argument — the server stores the default as NULL and reads it
    // back as the default number, so this is the window the partition memo must re-key on.
    setState((prev) => ({ ...prev, dormancyDays: res.dormancyDays }));
    return res.dormancyDays;
  }, []);

  const setBlockRemoteImages = useCallback(async (blocked: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const res = await link.current.setBlockRemoteImages(blocked);
    const on = res.blockRemoteImagesAt != null;
    // BOTH FIELDS FROM THE SAME ECHO, as with auto-suggest — a row reading "Off since <yesterday>"
    // about a refused write is the failure that rule exists to prevent, and here the refused write
    // is the one that would start loading a sender's images.
    setState((prev) => ({ ...prev, blockRemoteImages: on, blockRemoteImagesAt: res.blockRemoteImagesAt ?? null }));
    return on;
  }, []);

  const setBlockTrackingPixels = useCallback(async (blocked: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const res = await link.current.setBlockTrackingPixels(blocked);
    // The echo is the OPT-OUT instant; the flag is its absence. Inverted exactly once, here.
    const on = res.loadTrackingPixelsAt == null;
    setState((prev) => ({
      ...prev, blockTrackingPixels: on, loadTrackingPixelsAt: res.loadTrackingPixelsAt ?? null,
    }));
    return on;
  }, []);

  const setFoldersEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const res = await link.current.setFoldersEnabled(enabled);
    const on = res.foldersEnabledAt != null;
    // BOTH FIELDS FROM THE SAME ECHO — auto-suggest's rule: the boolean the shell gates on and
    // the instant the row displays must move together or not at all.
    setState((prev) => ({ ...prev, foldersEnabled: on, foldersEnabledAt: res.foldersEnabledAt ?? null }));
    // …AND THE DEVICE'S CACHED COPY MOVES WITH THEM. The boot cache paints the next reload's
    // first frame; leaving it at the pre-toggle answer would resurrect a rail the account just
    // turned off (or hide one it turned on) until — or unless — the live read lands. Only when
    // a cache row exists: no row means no stale copy to correct, and inventing one here would
    // cache partition inputs this tab never confirmed.
    const owner = readOwner();
    if (owner !== null && bootCache.current !== null) {
      const next: ConsentBootCache = { ...bootCache.current, foldersEnabledAt: res.foldersEnabledAt ?? null };
      writeBootCache(CONSENT_BOOT_SCOPE, owner, next);
      bootCache.current = next;
    }
    return on;
  }, []);

  const setMailboxFoldersEnabled = useCallback(
    async (mailboxId: string, enabled: boolean): Promise<Record<string, string>> => {
      // The user's act outranks every read in flight — see `writeEpoch`.
      writeEpoch.current += 1;
      const res = await link.current.setMailboxFoldersEnabled(mailboxId, enabled);
      const off = res.folderMailboxesOff ?? {};
      // THE WHOLE MAP FROM THE ECHO — the server answers with every exception after the write,
      // so a stale tab that missed another device's toggle heals on its own next write.
      setState((prev) => ({ ...prev, folderMailboxesOff: off, folderMailboxesKnown: true }));
      return off;
    }, []);

  const setBlockAutoUnsubscribe = useCallback(async (blocked: boolean): Promise<boolean> => {
    // The user's act outranks every read in flight — see `writeEpoch`. Bumped BEFORE the
    // request, so a re-ask racing this write is discarded whatever it answers.
    writeEpoch.current += 1;
    const res = await link.current.setBlockAutoUnsubscribe(blocked);
    // `== null` ⇒ the pass runs. The same collapse as the read above, for the same reason, and it
    // has to be spelled the same way in both places or a server that answered with the field
    // omitted would move the switch one way on load and the other on write.
    const on = res.blockAutoUnsubscribeAt == null;
    setState((prev) => ({
      ...prev,
      autoUnsubscribe: on,
      blockAutoUnsubscribeAt: res.blockAutoUnsubscribeAt ?? null,
    }));
    return on;
  }, []);

  // Derived rather than stored, so neither can be left behind by a `setState` that forgot it:
  // both are facts about the BUILD and the mode, settled before the first render. `active` is
  // `!demo`; see {@link ConsentState.standalone} and {@link ConsentState.cloudClient} for why
  // these are now two questions rather than one.
  return {
    ...state,
    standalone: active && !reachable,
    cloudClient: apiConfigured(),
    setAutoSuggest,
    setDormancyDays,
    setBlockRemoteImages,
    setBlockTrackingPixels,
    setBlockAutoUnsubscribe,
    setFoldersEnabled,
    setMailboxFoldersEnabled,
  };
}
