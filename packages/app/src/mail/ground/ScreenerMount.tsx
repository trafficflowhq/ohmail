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
 *
 * NOT HERE, and whose: the review of who the person writes to, which holds today's Junk window back while it is
 * owed (a stage of the mailboxes' own); a host's own suggestion control (it has no port).
 */
import { useMemo, type ReactNode } from "react";
import { useDemoMode, useEngine } from "@ohmail/app-logic/engine";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { nothingOrganizesOf } from "@ohmail/app-logic/mail-state/mail-state";
import {
  PILE_KEY,
  useScreenerLive,
  type ScreenerLiveInput,
  type ScreenerText,
} from "@ohmail/app-logic/screener";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { useFrame, usePress } from "../../frame/index.js";
import { useMailboxWord } from "../../frame/room.js";
import { NONE } from "../../host/index.js";
import { ScreenerAbove, segmentOf, type ScreenerBeside } from "../../screener/index.js";
import { useLocale, useText, useTimeZone } from "../../text/index.js";

/** The five places a decision files to, as the `place` namespace names them. */
const PLACES = ["ohbox", "reads", "receipts", "screened", "spam"] as const;

export function ScreenerMount({ children }: { readonly children: ReactNode }): ReactNode {
  const { host, route } = useFrame();
  const engine = useEngine();
  const demo = useDemoMode();
  const press = usePress();
  const { state, mailboxes: facts } = useMailState();
  const mailboxWord = useMailboxWord();
  const screener = useText("screener");
  const screening = useText("screening");
  const ohbox = useText("ohbox");
  const session = useText("session");
  const place = useText("place");
  const aiRefusal = useText("aiRefusal") as unknown as Translator;
  const locale = useLocale();
  const zone = useTimeZone();
  /* The model's words, composed where it is called, as the room composes its seam's. */
  const text = useMemo(
    (): ScreenerText => ({
      screener: screener as unknown as Translator,
      screening: screening as unknown as Translator,
      ohbox: ohbox as unknown as Translator,
      session: session as unknown as Translator,
      piles: {
        ohbox: screener(PILE_KEY.ohbox),
        reads: screener(PILE_KEY.reads),
        receipts: screener(PILE_KEY.receipts),
        screened: screener(PILE_KEY.screened),
        spam: screener(PILE_KEY.spam),
      },
      places: Object.fromEntries(PLACES.filter((id) => place.has(id)).map((id) => [id, place(id)])),
      locale,
      zone: () => zone,
    }),
    [screener, screening, ohbox, session, place, locale, zone],
  );
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
  const { model, junk, suggest } = useScreenerLive({
    press,
    scope,
    text,
    aiRefusal,
    at,
    junkWire,
    suggestWire,
    suggestControl: host.capabilities.suggest === "priced",
  });
  /* A price in credits is said only where the host is the managed service: nobody else meters a suggestion. */
  const priced = host.capabilities.service === "managed";
  const unsubscribeFrom = host.capabilities.unsubscribeFrom;
  const settled = state.settled;
  const owed = state.owed;
  const storeImportOpen = state.storeImportOpen === true;
  const beside = useMemo(
    (): ScreenerBeside => ({
      letters: NONE,
      junk: junk ?? NONE,
      suggest: suggest === null ? NONE : { priced, control: suggest },
      /* The one-press unsubscribe is sent by whoever the host says sends it; where it says nobody, no press. */
      unsubscribe: demo || unsubscribeFrom === NONE ? NONE : (messageId) => engine.unsubscribe(messageId),
      mailboxWord,
      invitation: NONE,
      facts: { settled, owed, storeImportOpen, notOrganizingYet: demo ? null : nothingOrganizesOf(facts) },
      undo: () => press.runArmedUndo(),
    }),
    [
      junk,
      suggest,
      priced,
      demo,
      unsubscribeFrom,
      engine,
      mailboxWord,
      settled,
      owed,
      storeImportOpen,
      facts,
      press,
    ],
  );
  return (
    <ScreenerAbove model={model} beside={beside}>
      {children}
    </ScreenerAbove>
  );
}
