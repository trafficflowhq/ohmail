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
 * ── AND WHY A FAILURE IS SILENT ──────────────────────────────────────────────────────────
 *
 * The default is the product default, which is what the client engine uses anyway. A tab that
 * could not reach this endpoint partitions exactly as it would have before the endpoint
 * existed, so a network blip must not produce an error anybody has to read.
 */

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/client-engine";
import { apiConfigured, consent as consentApi, type ConsentStateWire } from "../api-client";
import { normalizeLocale, type AppLocale } from "./locale";

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
   * On a standalone install there is no stored window. `apiConfigured()` is false, the fetch
   * never runs, `known` is false for the life of the process — and the shell read that as "the
   * answer has not arrived", switched the cutline off, and drew the Screener over the raw
   * mirror. No History pile at all, and every sender whose mail had already been filed into the
   * Screener folder sat in the queue for ever. `DEFAULT_DORMANCY_DAYS` is not a guess here: it
   * is the only window this build has, the one the engine uses unasked, and the one the dial
   * would have to be turned away from — but there is no dial, because there is nowhere to
   * store the number.
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
  // ON AT REST, which is the PRODUCT DEFAULT and not the contrarian value the line above is. See
  // {@link ConsentState.autoUnsubscribe}: this flag decides whether a consequence is stated, never
  // whether it happens, so the safe resting value is the one that describes what the server does.
  autoUnsubscribe: true,
  blockAutoUnsubscribeAt: null,
  // NOTHING FROM AN ACCOUNT. Unlike `blockRemoteImages` above, resting null is not a safe
  // *position* — it is the absence of one, and it leaves the language this device remembered in
  // charge. See {@link ConsentState.locale}.
  locale: null,
  known: false,
  standalone: false,
};

/**
 * @param active `false` on the demo and the desktop, which have no server. Both keep
 * {@link RESTING}, which is the same window the engine would have used unasked.
 */
export function useConsentState(active: boolean): ConsentState & {
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
} {
  const [state, setState] = useState<ConsentState>(RESTING);

  useEffect(() => {
    if (!active || !apiConfigured()) return;
    let live = true;
    void (async () => {
      try {
        const wire: ConsentStateWire = await consentApi.state();
        if (!live) return;
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
          // `== null` — BOTH null and undefined — which is the line four above's shape and NOT the
          // one directly above it, and the difference is deliberate in both places. For images the
          // two are different answers because only one of them may load a sender's content. Here
          // they are the same answer: neither carries a stored opt-out, so in both cases the
          // server is going to unsubscribe and the interface has to say so.
          autoUnsubscribe: wire.blockAutoUnsubscribeAt == null,
          blockAutoUnsubscribeAt: wire.blockAutoUnsubscribeAt ?? null,
          // NORMALISED, not trusted. The column's CHECK and `consentSettings` both close the set,
          // so an unsupported string cannot arrive from a current server — and this is the boot
          // path, where a value that got through would make the client ask for a catalogue that
          // does not exist. `normalizeLocale` answers null for anything it does not recognise,
          // which lands on exactly the same branch as "this account has no preference".
          locale: normalizeLocale(wire.locale),
          known: true,
          standalone: false,
        });
      } catch {
        // Deliberately silent — see the header.
      }
    })();
    return () => { live = false; };
  }, [active]);

  const setAutoSuggest = useCallback(async (enabled: boolean): Promise<boolean> => {
    const res = await consentApi.setAutoSuggest(enabled);
    const on = res.autoSuggestAt != null;
    // BOTH FIELDS FROM THE SAME ECHO. Setting the boolean from the server and the instant from
    // the argument (or leaving it stale) is how a row reads "On since <yesterday>" about a write
    // that was refused — the two must move together or not at all.
    setState((prev) => ({ ...prev, autoSuggest: on, autoSuggestAt: res.autoSuggestAt ?? null }));
    return on;
  }, []);

  const setDormancyDays = useCallback(async (days: number | null): Promise<number> => {
    const res = await consentApi.setDormancyDays(days);
    // FROM THE SERVER ECHO, never the argument — the server stores the default as NULL and reads it
    // back as the default number, so this is the window the partition memo must re-key on.
    setState((prev) => ({ ...prev, dormancyDays: res.dormancyDays }));
    return res.dormancyDays;
  }, []);

  const setBlockRemoteImages = useCallback(async (blocked: boolean): Promise<boolean> => {
    const res = await consentApi.setBlockRemoteImages(blocked);
    const on = res.blockRemoteImagesAt != null;
    // BOTH FIELDS FROM THE SAME ECHO, as with auto-suggest — a row reading "Off since <yesterday>"
    // about a refused write is the failure that rule exists to prevent, and here the refused write
    // is the one that would start loading a sender's images.
    setState((prev) => ({ ...prev, blockRemoteImages: on, blockRemoteImagesAt: res.blockRemoteImagesAt ?? null }));
    return on;
  }, []);

  const setBlockAutoUnsubscribe = useCallback(async (blocked: boolean): Promise<boolean> => {
    const res = await consentApi.setBlockAutoUnsubscribe(blocked);
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

  // Derived rather than stored, so it cannot be left behind by a `setState` that forgot it: it
  // is a fact about the BUILD and the mode, and both are settled before the first render.
  // `active` is `!demo`; see {@link ConsentState.standalone}.
  return {
    ...state,
    standalone: active && !apiConfigured(),
    setAutoSuggest,
    setDormancyDays,
    setBlockRemoteImages,
    setBlockAutoUnsubscribe,
  };
}
