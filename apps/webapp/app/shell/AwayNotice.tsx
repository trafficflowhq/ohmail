"use client";

/**
 * THE AWAY RESPONDER'S OHBOX NOTICE — the tell for the one thing this product does that sends
 * mail on its own.
 *
 * `AwayResponderRow` (Settings → Away responder) is the control; this is its visibility. Without it,
 * the only state in which mail leaves the account unprompted was legible on exactly one settings
 * pane and nowhere else — least of all on the pane its owner spends the day on. The notice is one
 * quiet line: the fact, the audience it is true for, and the way to the control.
 *
 * ── ONE READ PER TAB, HELD BY THE SHELL ──────────────────────────────────────────────────
 *
 * The responder row is REST-only and deliberately has no `/sync` entity (see the api-client
 * note on `away`), so there is no mirror to read and none may be invented for this. Instead
 * {@link useAwayNotice} issues the same `GET /away-responder` the settings row loads — ONCE per
 * shell mount — and the SHELL holds the answer, so the Ohbox can mount and unmount all day
 * without another round trip. Same-tab edits stay honest through the settings row's `onChanged`
 * echo into {@link AwayNoticeState.update}, never through a refetch. A SECOND tab keeps its
 * stale answer until reload — the same accepted cost `consent-state.ts` states for the dormancy
 * dial, and cheaper here: the stale surface is one advisory line, not a partition.
 *
 * A failed read stays silent and the notice stays absent — the pre-notice surface, not a guess.
 * The direction matters: this line claims mail is being answered on somebody's behalf, and that
 * claim may only ever come from the server's own row. There is no path from "I do not know" to
 * "replies are going out".
 *
 * ── ONE KEY, TWO SELECTS ─────────────────────────────────────────────────────────────────
 *
 * This was two keys, one per audience, because "a single sentence covering both audiences would
 * be false for one of them". That reasoning was right and does not scale: the notice now has to
 * carry the RATE as well, and a key per combination is eight sentences to write, translate and
 * keep in agreement — where the failure mode is one of the eight quietly describing a responder
 * that behaves differently.
 *
 * So it is ONE ICU message with two `select`s, which is what ICU is for: the catalogue holds one
 * sentence whose two variable parts are enumerated, a translator sees the whole sentence rather
 * than eight fragments, and adding a fifth rate is one arm rather than four keys. Both selects
 * fall through to `other` — `screened_in` and `per_day`, the two defaults — so a value this
 * component has not been taught still produces a true sentence rather than an empty one.
 *
 * The claim it makes is a claim about the SERVER's behaviour: the pass's throttle, not this
 * component's. If the throttle's meaning changes, this sentence is edited in the same change.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Banner } from "@ohmail/ui";
import { awayScopeKey, type AwayScope } from "@trafficflow/core/away-scope";
import { apiConfigured, away as awayApi, type AwayResponderWire } from "../api-client";
import type { AwayTransport } from "./AwayResponderRow";
import { go } from "./routing";

type Audience = AwayResponderWire["audience"];
type Throttle = AwayResponderWire["throttle"];
type Piles = AwayResponderWire["piles"];

/** THE COPY SHIM. One object, so the i18n pass has one thing to move. */
/**
 * THE ENGLISH SENTENCES, KEPT as the shape of these three keys and not read at render — see
 * `AwayResponderRow`'s `AWAY_COPY` for why the constant survives its own migration.
 *
 * The three live under `away.notice*` rather than in a namespace of their own: they are the same
 * feature's vocabulary as the settings row's, and a reader of `de.json` should find every sentence
 * about the responder in one place.
 */
export const AWAY_NOTICE_COPY = {
  /**
   * THE VERB LIVES WITH ITS SUBJECT, and that is the whole reason this sentence is shaped the
   * way it is. "gets" used to sit in the THROTTLE arm, where it cannot know which audience it
   * is agreeing with — so one of the two combinations was always ungrammatical ("people you've
   * let in gets a reply"). The verb is in the AUDIENCE arm now, inflected per branch, and the
   * throttle arms are noun phrases that read after either one. That is also how the German
   * catalogue has always carried it, so the two are now the same shape.
   *
   * Eight combinations, all grammatical, and a test walks every one of them in both languages.
   */
  notice:
    "Away responder is on — {audience, select, everyone {everyone who writes} other {people you've let in}} "
    + "{scope, select, reads {whose mail lands in Reads} ohbox_reads {whose mail lands in Ohbox or Reads} "
    + "other {whose mail lands in Ohbox}} "
    + "{audience, select, everyone {gets} other {get}} "
    + "{throttle, select, always {a reply to every message} per_message {one reply, until you change the text} "
    + "per_week {a reply at most once a week} other {a reply at most once a day}}.",
  /**
   * THE ONE SCOPE THE SENTENCE ABOVE CANNOT CARRY — a responder that is ON with no pile selected.
   *
   * `awayScopeKey` answers `none` for an empty `piles`, which the column's containment CHECK
   * allows and which is what unticking every box means. Given a `none` arm inside the sentence,
   * every wording that fits the grammar is false: "…whose mail lands in Ohbox get a reply" claims
   * replies are going out, and an empty arm claims it even more quietly by leaving the clause out.
   * A responder answering nobody is a different fact and gets a different sentence.
   */
  noticeNone: "Away responder is on, but no pile is set to get a reply — nothing is sent.",
  noticeSettings: "Away settings",
} as const;

export interface AwayNoticeState {
  /** Is the responder ON, as the server's row last answered or echoed. Resting false. */
  on: boolean;
  /** Who gets a reply — one half of what the notice may truthfully say. */
  audience: Audience;
  /** How often each of them gets one — the other half. */
  throttle: Throttle;
  /**
   * WHICH PILES ARE ANSWERED, as the one word the sentence is chosen by.
   *
   * Derived through `awayScopeKey` (`@trafficflow/core/away-scope`) rather than kept as the array,
   * so the notice and the engine cannot disagree about what a stored `piles` MEANS. Resting
   * `"ohbox"`, which pairs with `on: false` — the notice is absent until the server has said
   * otherwise, so the resting value is never on screen.
   */
  scope: AwayScope;
  /**
   * THE SETTINGS ROW'S ECHO. `AwayResponderRow` calls this with what the SERVER answered —
   * its mount load and every save echo, never what a click asked for — so the row and this
   * notice can only agree. It is the whole of how a same-tab edit reaches the Ohbox.
   */
  update: (
    next: { enabled: boolean; audience: Audience; throttle: Throttle; piles: Piles },
  ) => void;
}

/**
 * One `GET /away-responder` per shell mount, gated like the settings row: `active` is the
 * shell's `!demo && awaySupported`, and when no host transport is supplied `apiConfigured()` is
 * re-checked here so a standalone install asks nothing even if a caller ever mis-wires the flag.
 *
 * `transport` is the same seam the settings row takes ({@link AwayTransport}) and exists for the
 * same install: the desktop on its HOSTED door, where the row is real and reached over the pipe
 * rather than over a socket this window is forbidden to open. Absent ⇒ the hosted client, which is
 * what a browser tab has.
 */
export function useAwayNotice(active: boolean, transport?: AwayTransport): AwayNoticeState {
  const [state, setState] = useState<{
    on: boolean; audience: Audience; throttle: Throttle; scope: AwayScope;
  }>({
    on: false,
    audience: "screened_in",
    throttle: "per_day",
    scope: "ohbox",
  });

  /* Through a ref so the effect below keeps its `[active]` deps — ONE read per shell mount is the
     whole design, and a transport identity that changed between renders would re-issue it. */
  const held = useRef(transport);
  held.current = transport;

  /**
   * SET ONCE THE SETTINGS ROW HAS TOLD US THE TRUTH, so the initial read cannot undo it.
   *
   * The one-shot GET and the row's save echo are two writers with no order between them. `alive`
   * only stops a write after unmount. So: the shell starts its read, the reader opens Away
   * settings and saves, `update()` installs what the server answered — and then the OLDER read
   * resolves and overwrites it. Because the design deliberately never refetches, the notice then
   * states the wrong rate or audience for the rest of the tab's life, which is a sentence about
   * mail leaving the account unprompted. The newer fact wins, whichever arrives second.
   */
  const superseded = useRef(false);

  useEffect(() => {
    /* `active` FIRST, and this order is load-bearing rather than tidy: an inactive shell must not
       so much as NAME the Cloud client. On a standalone install that binding is a stub whose every
       property refuses, and a suite that mocks `../api-client` throws on the read itself — which is
       exactly how this was caught, by three unrelated tests, after a version of this effect
       resolved the transport before it checked the gate. */
    if (!active) return;
    const via = held.current ?? (apiConfigured() ? awayApi : null);
    if (!via) return;
    let alive = true;
    void (async () => {
      try {
        const loaded = await via.state();
        // `superseded` as well as `alive`: a save that landed while this was in flight is NEWER.
        if (alive && !superseded.current) {
          setState({
            on: loaded.enabled,
            audience: loaded.audience,
            throttle: loaded.throttle,
            /* `?? []` and not `?? ["INBOX"]`. A server one release older answers no `piles` at
               all, and inventing the Ohbox there would put a scope sentence on screen that the
               server never stated — the same "no path from 'I do not know' to 'replies are going
               out'" rule this file's header sets for the notice as a whole. An empty array reads
               as `none`, whose sentence claims nothing is being sent. */
            scope: awayScopeKey(loaded.piles ?? []),
          });
        }
      } catch {
        // No server, or a refused read: the notice stays absent, which is the surface this
        // slice found — never a claim the server has not made.
      }
    })();
    return () => { alive = false; };
  }, [active]);

  const update = useCallback((
    next: { enabled: boolean; audience: Audience; throttle: Throttle; piles: Piles },
  ) => {
    // This is the server's own answer to a write, so it outranks any read still in flight.
    superseded.current = true;
    setState({
      on: next.enabled,
      audience: next.audience,
      throttle: next.throttle,
      scope: awayScopeKey(next.piles ?? []),
    });
  }, []);

  return {
    on: state.on, audience: state.audience, throttle: state.throttle, scope: state.scope, update,
  };
}

/**
 * The deep link `initialPaneFromUrl` reads at mount: `?settings=away` names the pane, the
 * hash names the view. `replaceState` for the parameter (no history entry for a URL edit that
 * is half of one navigation), then the ordinary `go` for the view change itself.
 *
 * It was `screener` for as long as the control was that pane's last row. The responder has its
 * own section now (`SettingsView`'s `away` pane), and this affordance is the one place in the
 * product that promises to land on it — a stale pane name here would still open Settings, on a
 * pane that no longer holds the control, which is the failure this line exists to prevent.
 */
function openAwaySettings(): void {
  const url = new URL(window.location.href);
  url.searchParams.set("settings", "away");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  go("settings");
}

/**
 * The line itself. Presentational on purpose: whether there is anything to say — and on which
 * install — is the shell's call (`useAwayNotice` plus the `noticeSection` gate in `AppShell`),
 * so this component renders unconditionally what it is handed and holds no state of its own.
 *
 * `role="status"`: the responder being on is exactly the kind of ambient fact a screen reader
 * should hear once and not be interrupted by.
 *
 * IT IS A STANDING PANE, NOT A SUBLINE — the `Banner` primitive (`packages/ui`). Every other
 * line in the header slot announces a CHANGE and can be made to go — the organizer notice keeps a
 * "Mark read" that ends it. This one states a condition that holds until its owner ends it, and it
 * was reported from real use as reading like one more pile description, which is the one thing it
 * is not. The box is the difference; the words are unchanged.
 *
 * AND IT IS THE LIST'S FIRST BLOCK, NOT THE HEADER'S LAST LINE. Rendered through `OhboxView`'s
 * `standingNotice` slot — inside the scroller — so the banner's one media rule can give it both
 * forms: pinned at the top of the list on a desktop, where a standing fact belongs in view; in the
 * flow on a phone, read at the top and gone with the first swipe, where the same line pinned
 * would be a toolbar taking a third of the screen. The offer and the organizer notice stay in the
 * header slot — they must not scroll away, and they must not displace the doorbell.
 *
 * `ohx-away` is a hook for tests and the fit harness; nothing styles it.
 */
export function AwayNotice(
  { audience, throttle, scope }: { audience: Audience; throttle: Throttle; scope: AwayScope },
) {
  const t = useTranslations("away");
  return (
    <Banner
      className="ohx-away"
      action={
        <button type="button" onClick={openAwaySettings}>
          {t("noticeSettings")}
        </button>
      }
    >
      {/* A RESPONDER ANSWERING NOBODY GETS ITS OWN SENTENCE, never an arm of the one below.
          Every wording that fits that sentence's grammar is false for an empty scope — see
          `AWAY_NOTICE_COPY.noticeNone`. */}
      {scope === "none" ? t("noticeNone") : t("notice", { audience, throttle, scope })}
    </Banner>
  );
}
