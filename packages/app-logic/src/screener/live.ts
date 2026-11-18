/**
 * THE SCREENER'S ONE MODEL OVER THE MAIL GROUND, AND WHAT RUNS BESIDE IT: the model's input assembled from the
 * engine and the ground's own contexts (the consent row, the partition, the presented mirror, the mail state), the
 * one call of `useScreenerModel` a frame makes, and the one call each of the suggestion run and of the Junk window,
 * each over its host's own wire or `"none"`. It takes the frame's press seam, the pinned scope, the words, the two
 * wires and where the frame stands as arguments, because this package cannot read the frame.
 *
 * Called ONCE a mounted frame, by the ground's mount, above every pane: the queue's count, each decision's commit
 * timer and its Undo window live in the model, what was bought lives in the run and the Junk folder's page in the
 * window, so they live for the frame's life and end once. Never called by a pane, a place or a seat: a second call
 * is a second journal, a second set of timers, a second read of the Junk folder and a second purchase.
 *
 * NO WIRE OF ITS OWN: over `"none"` the Junk folder is read by nobody and no suggestion is listed, priced or bought.
 * THE WIRE DECIDES WHAT IS ASKED, THE HOST WHAT IS DRAWN: where the host draws no shared control nothing binds the
 * run to the queue, so nothing is priced or bought there, with or without a press.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useMemo } from "react";
import { autoUnsubscribeConfirms, mirrorSuggestionIdOf } from "@ohmail/client-engine";
import { useConsent } from "../consent/consent-row.js";
import { usePartition } from "../consent/partition.js";
import { useDemoMode, useDerivedVersion, useEngine, useResolvedDemoMode } from "../engine/index.js";
import { useMailState } from "../mail-state/mail-state-binding.js";
import { screenerMode } from "../mail-state/mail-state.js";
import { screeningShown } from "../press/press-verdict.js";
import { postureRefusal, rulesPostureOf } from "../press/rules-posture.js";
import { autoUnsubscribeDoor } from "../press/sender-screening.js";
import type { ShellDispatch } from "../press/shell-dispatch.js";
import { useStableCallback } from "../press/stable-callback.js";
import { usePresentedMirror } from "../reading/presented-mirror.js";
import type { Translator } from "../text/translator.js";
import type { DecisionDestination } from "./decision.js";
import { useJunkPileKey, useJunkWindow, type JunkWindowControl, type JunkWire } from "./junk-window.js";
import { useScreenerModel } from "./model.js";
import type { ScreenerState, ScreenerText } from "./screener-state.js";
import {
  useScreenerSuggestions,
  type AutoOptInControl,
  type SuggestBatchControl,
  type SuggestWire,
} from "./screener-suggest.js";

export interface ScreenerLiveInput {
  /** The frame's one press seam: its undo door is the model's, and its window holds a rule change for its Undo. */
  readonly press: ShellDispatch;
  /** The host's scope, as the frame pinned it: whose journal and undo channel these are. */
  readonly scope: string;
  readonly text: ScreenerText;
  /** The catalogue's reader of the refusals every surface shares: the run says a refused purchase through it. */
  readonly aiRefusal: Translator;
  /** Where the frame stands: the Screener on screen, and its third section. Nothing is read for a place away. */
  readonly at: { readonly screener: boolean; readonly third: boolean };
  /** The host's own Junk wire, or `"none"`: over none the mail server's Junk folder is read by nobody. */
  readonly junkWire: JunkWire | "none";
  /** The host's own suggestion wire, or `"none"`: over none nothing is listed, priced or bought. */
  readonly suggestWire: SuggestWire | "none";
  /** Whether this host draws the shared suggestion control. Where it does not, nothing is priced or bought. */
  readonly suggestControl: boolean;
}

/** What a mounted frame holds of the Screener: its one model, and what runs beside it. */
export interface ScreenerLive {
  readonly model: ScreenerState;
  /**
   * The mail server's own Junk, read live; null where no window stands: the host named no wire, the account files
   * into no folders, or the invented mailbox is on screen.
   */
  readonly junk: JunkWindowControl | null;
  /** The suggestion run's control, bound to this render's queue; null where the host draws none or has no wire. */
  readonly suggest: SuggestBatchControl | null;
  /** The opt-in's quote, bound to this render's unsuggested senders; null over none or on the invented mailbox. */
  readonly autoOptIn: AutoOptInControl | null;
}

export function useScreenerLive({
  press,
  scope,
  text,
  aiRefusal,
  at,
  junkWire,
  suggestWire,
  suggestControl,
}: ScreenerLiveInput): ScreenerLive {
  const engine = useEngine();
  const version = useDerivedVersion();
  /* What is drawn reads the answer that is safe in render: the server's on the hydration render, so the markup
     matches the page that was served, and the browser's own from the render after it. */
  const demo = useDemoMode();
  /* What dials a wire is gated on the browser's own answer, never on the flag a page was served with. */
  const invented = useResolvedDemoMode();
  const consent = useConsent(); // throws where no ground stands above
  const { ownAddresses, firstImportDoneAt } = usePartition(); // throws where no ground stands above
  const presented = usePresentedMirror();
  if (presented === null)
    throw new Error("the Screener's model was mounted with no presented mirror above it");
  const { mailboxes: facts } = useMailState();
  /* Will a Screen out or Spam press also send the one-click unsubscribe: the account's switch, a service to reach,
     and a mailbox whose provider's word is read. The one answer every disclosure reads. */
  const { discloses } = autoUnsubscribeDoor({
    demo,
    known: consent.known,
    on: consent.autoUnsubscribe,
    standalone: consent.standalone,
    confirms: autoUnsubscribeConfirms(facts),
  });
  /* What this install may do with a decision, and the refusal a press would meet, from the mail state's roster. */
  const role = useMemo(
    () => ({ ...screenerMode(facts), pressRefusal: postureRefusal(rulesPostureOf(facts)) }),
    [facts],
  );
  /* The pressed rows the lists show at a place, read at the call over the lists' own partition. */
  const shownAt = useStableCallback((subject: readonly EngineMessage[], dest: DecisionDestination) =>
    screeningShown(engine.read(), subject, dest, {
      consent: demo ? null : consent,
      now: new Date(),
      ownAddresses,
      firstImportDoneAt,
    }),
  );
  /* THE SUGGESTION RUN, once: what was bought is read when the Screener comes on screen, and a batch is bought
     without a press only for an account whose own row says so. Over none it asks nothing. */
  const suggestText = useMemo(() => ({ screener: text.screener, aiRefusal }), [text.screener, aiRefusal]);
  const mirrorSuggestionOf = useMemo(
    () => (address: string) => mirrorSuggestionIdOf(engine.read(), address),
    [engine],
  );
  const run = useScreenerSuggestions({
    active: !invented && at.screener,
    autoSuggest: consent.autoSuggest,
    toast: press.undoToast,
    text: suggestText,
    wire: suggestWire,
    mirrorSuggestionOf,
  });
  const model = useScreenerModel({
    engine,
    scope,
    version,
    toast: press.undoToast,
    text,
    /* Over no wire this host buys none and lists no decision another session left. */
    suggestions: suggestWire === "none" ? null : run.suggestions,
    presented,
    autoUnsubscribe: discloses,
    role,
    outstanding: run.outstandingDecisions,
    ownAddresses,
    shownAt,
    releaseWindow: press.screenerRelease ?? null,
  });
  const junk = useJunkHere(
    press,
    junkWire,
    text.screener,
    at,
    !invented && consent.foldersEnabled,
    !demo && consent.foldersEnabled,
  );
  /* The control is bound at the render to the very lists the model computed in it, so the set that is priced and
     the set that is bought are one list. Bound only where the host draws it: the batch nobody presses for reads the
     list this binding leaves, so without a control it has nothing to buy. */
  const offered = !demo && suggestControl && suggestWire !== "none" && suggestWire.configured();
  const suggest = offered
    ? run.forSenders(
        model.unsuggestedSenders,
        model.suggestedSenders,
        model.waitingCount - model.suggestedCount,
        model.queueSettled,
      )
    : null;
  return {
    model,
    junk,
    suggest,
    autoOptIn: demo || suggestWire === "none" ? null : run.autoOptIn(model.unsuggestedSenders),
  };
}

/**
 * THE JUNK WINDOW, once: the folder's page and the preview are read when the frame comes up for an account that
 * files into folders (`on`), and again after a letter enters or leaves the spam pile. Over none it reads nothing,
 * says it is not supported, and no window stands. `on` is what dials, read off the browser's own answer; `drawn`
 * is whether the window is handed to be drawn, read off the answer that is safe in render.
 */
function useJunkHere(
  press: ShellDispatch,
  wire: JunkWire | "none",
  t: Translator,
  at: ScreenerLiveInput["at"],
  on: boolean,
  drawn: boolean,
): JunkWindowControl | null {
  const moved = useJunkPileKey(on);
  const keep = useMemo(() => ({ on, moved }), [on, moved]);
  const junk = useJunkWindow(on && at.third, press.undoToast, wire, t, on && at.screener, keep);
  return drawn && junk.supported ? junk : null;
}
