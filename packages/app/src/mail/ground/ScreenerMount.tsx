"use client";

/**
 * THE SCREENER'S MODEL, MOUNTED ABOVE THE PANES: the queue of senders waiting, each decision with its commit timer
 * and its Undo window, the suggestions joined on, and the count the rail draws. One model for a mounted frame
 * (`useScreenerLive`, called here and nowhere else), stood as `ScreenerAbove`, so the Screener's panes, another
 * place's doorbell and a rail entry read the same one, and a decision pressed at one place ends once wherever the
 * person has walked since.
 *
 * It reads the pieces above it (the mail state, the consent row, the partition, the presented mirror), the frame's
 * press seam and the host. BESIDE the model it hands the Screener what a host answers: the one-press unsubscribe
 * where the host says who sends it, a mailbox's word, the frame's undo, and THE JUNK WINDOW AND THE SUGGESTION RUN,
 * each one instance for the frame's life, each over the host's own wire or `none`, never a default. Over a Junk
 * wire of `none`, or for an account that files into no folders, the third section is Spam and the mail server's
 * Junk folder is read by nobody. Over a suggestion wire of `none` nothing is listed, priced or bought; the control
 * is drawn only where the host says it draws the shared one, and without it nothing is priced or bought either.
 * THE BATCH NOBODY PRESSED FOR is bought only on a host that says `priced`: one that says `pressed` draws the same
 * control and buys on its press alone, whatever the account's own row says.
 *
 * NOT HERE, and whose: the review of who the person writes to, which holds today's Junk window back while it is
 * owed (a stage of the mailboxes' own).
 */
import { useMemo, type ReactNode } from "react";
import { useDemoMode, useEngine } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { nothingOrganizesOf } from "@ohmail/app-logic/mail-state/mail-state";
import { useScreenerLive, type ScreenerLiveInput } from "@ohmail/app-logic/screener";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { useFrame, usePress } from "../../frame/index.js";
import { useMailboxWord } from "../../frame/room.js";
import { NONE } from "../../host/index.js";
import { ScreenerAbove, segmentOf, type ScreenerBeside } from "../../screener/index.js";
import { ScreenerPrimer } from "../../screener/Primer.js";
import { useScreenerWords } from "../../screener/words.js";
import { useText } from "../../text/index.js";

const useNoHeldParts = (): typeof NONE => NONE;

export function ScreenerMount({
  children,
  subjectRule,
}: {
  readonly children: ReactNode;
  readonly subjectRule?: ScreenerBeside["subjectRule"];
}): ReactNode {
  const { host, route } = useFrame();
  const reader = host.features.reader;
  const useHeldParts = reader === NONE ? useNoHeldParts : (reader.useHeldParts ?? useNoHeldParts);
  const letters = useHeldParts();
  const engine = useEngine();
  const demo = useDemoMode();
  const press = usePress();
  const { state, mailboxes: facts } = useMailState();
  const mailboxWord = useMailboxWord();
  const aiRefusal = useText("aiRefusal") as unknown as Translator;
  const text = useScreenerWords();
  /* Under `Scoped` the host's scope is a mailbox's own: a refused scope mounts nothing of the ground. */
  const scope = host.session.scope;
  if (scope === null) throw new Error("the Screener's model was mounted under no scope");
  /* Where the frame stands: the stored suggestions are read once the Screener is on screen, the Junk folder's
     page again at its third section. */
  const screenerOn = route.place === "screener";
  const third = screenerOn && segmentOf(route.sub) === "spam";
  const at = useMemo(() => ({ screener: screenerOn, third }), [screenerOn, third]);
  /* The host's own two wires, or none. The one cast each: the contract names a wire's answers opaquely, and
     their one declaration is the window's and the run's own. */
  const junkWire = host.wires.junk as unknown as ScreenerLiveInput["junkWire"];
  const suggestWire = host.wires.suggest as unknown as ScreenerLiveInput["suggestWire"];
  /* What the host says of its suggestion control: one answer decides what is drawn and what is bought unpressed. */
  const control = host.capabilities.suggest;
  const screener = host.features.screener;
  const ownSuggest = !demo && control === "ownModel" && screener !== NONE ? screener.ownSuggest : undefined;
  const { model, junk, suggest, autoOptIn, standing, inFlight, absorb, windowDegrade } = useScreenerLive({
    press,
    scope,
    mirrorAccount: host.session.mirrorAccount ?? undefined,
    text,
    aiRefusal,
    at,
    junkWire,
    suggestWire,
    suggestControl: control === "priced" || control === "pressed",
    ownSuggest: ownSuggest !== undefined,
    unpressed: control === "priced",
    cloud: host.capabilities.service === "managed",
  });
  /* A price in credits is said only where the host is the managed service: nobody else meters a suggestion. */
  const priced = host.capabilities.service === "managed";
  /* Where credits come from is said by naming Settings' pane, only where the host lists that pane. */
  const subscriptionPane = host.features.subscription !== NONE;
  const unsubscribeFrom = host.capabilities.unsubscribeFrom;
  const settled = state.settled;
  const owed = state.owed;
  const storeImportOpen = state.storeImportOpen === true;
  const beside = useMemo(
    (): ScreenerBeside => ({
      letters,
      windowNotice: windowDegrade ?? undefined,
      autoOptIn,
      ownSuggest: ownSuggest?.({ senders: model.unsuggestedSenders, absorb }),
      junk: junk ?? NONE,
      suggest:
        suggest === null
          ? NONE
          : { priced, control: suggest, noAdvice: { standing, inFlight, subscriptionPane } },
      /* The one-press unsubscribe is sent by whoever the host says sends it; where it says nobody, no press. */
      unsubscribe: demo || unsubscribeFrom === NONE ? NONE : (messageId) => engine.unsubscribe(messageId),
      mailboxWord,
      invitation: NONE,
      subjectRule,
      facts: { settled, owed, storeImportOpen, notOrganizingYet: demo ? null : nothingOrganizesOf(facts) },
      undo: () => press.runArmedUndo(),
    }),
    [
      letters,
      windowDegrade,
      junk,
      autoOptIn,
      ownSuggest,
      model.unsuggestedSenders,
      absorb,
      suggest,
      standing,
      inFlight,
      subscriptionPane,
      priced,
      demo,
      unsubscribeFrom,
      engine,
      mailboxWord,
      subjectRule,
      settled,
      owed,
      storeImportOpen,
      facts,
      press,
    ],
  );
  return (
    <ScreenerAbove model={model} beside={beside}>
      <ScreenerPrimer active={screenerOn ? segmentOf(route.sub) : null} />
      {children}
    </ScreenerAbove>
  );
}
