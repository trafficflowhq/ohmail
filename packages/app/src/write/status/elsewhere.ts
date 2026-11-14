/**
 * A LETTER THAT WENT ELSEWHERE, SAID: the row this letter is written over was sent, deleted or changed on another device
 * (the composition's `composeElsewhere`). The letter's note says so in today's sentence, chosen as today's composer
 * chose it; Send sends nothing over it: said as off, its hint the reason, its press told in place; and where today's
 * offered it (a letter deleted or changed there, or words typed here since), "Send as a new letter", whose press is the
 * composition's own send (the words on screen as a letter of their own, never the row that went). Nothing here decides
 * whether a letter may go: the send machine's gate is the composition's.
 */
import { useCallback, useEffect, useState } from "react";
import type { ComposeElsewhere } from "@ohmail/app-logic/writing/compose-autosave";

type NoteKey =
  | "sentElsewhere"
  | "sentElsewhereKept"
  | "deletedElsewhere"
  | "deletedElsewhereKept"
  | "changedElsewhere"
  | "changedElsewhereUnsaved";
type SendKey = "sentElsewhereSend" | "deletedElsewhereSend" | "changedElsewhereSend";
type OfferKey = "sendAsNew";
type DiscardKey =
  | "cancelWhatChangedElsewhere"
  | "cancelWhatDeletedElsewhere"
  | "cancelWhatDeletedElsewhereTyped"
  | "cancelWhatSentElsewhere"
  | "cancelWhatSentElsewhereTyped";

/** The note's sentence: what happened there, and whether the words here were kept (today's choice, word for word). */
export function elsewhereNoteKey(e: ComposeElsewhere): NoteKey {
  if (e.why === "changed") return e.kept ? "changedElsewhere" : "changedElsewhereUnsaved";
  if (e.why === "deleted") return e.earlier ? "deletedElsewhereKept" : "deletedElsewhere";
  return e.earlier ? "sentElsewhereKept" : "sentElsewhere";
}

/** Why a press of Send sent nothing. */
export function elsewhereSendKey(e: ComposeElsewhere): SendKey {
  return e.why === "changed"
    ? "changedElsewhereSend"
    : e.why === "deleted"
      ? "deletedElsewhereSend"
      : "sentElsewhereSend";
}

/** What Discard closes, and whether it will remove words typed after the original row went. */
function elsewhereDiscardKey(e: ComposeElsewhere): DiscardKey {
  if (e.why === "changed") return "cancelWhatChangedElsewhere";
  if (e.why === "deleted")
    return e.typedSince ? "cancelWhatDeletedElsewhereTyped" : "cancelWhatDeletedElsewhere";
  return e.typedSince ? "cancelWhatSentElsewhereTyped" : "cancelWhatSentElsewhere";
}

/** Whether the words on screen are offered as a new letter: never for an unchanged letter that already went. */
export function offersAsNew(e: ComposeElsewhere): boolean {
  return e.typedSince || e.why !== "sent";
}

/** How the letter's save lines read a letter that went: words typed since are a new draft of their own. */
export function elsewhereForSave(e: ComposeElsewhere | null): "none" | "typed" | "untyped" {
  return e === null ? "none" : e.typedSince ? "typed" : "untyped";
}

export interface WentElsewhere {
  /** The note's sentence while the letter went elsewhere; else null. */
  readonly note: string | null;
  readonly discardReason: string | null;
  /** Send's reason while the letter went elsewhere (its hint, and what its press says); else null. */
  readonly refusal: string | null;
  /** A press of Send was refused for it: the line says why, with the offer where it stands. */
  readonly told: boolean;
  /** "Send as a new letter" is offered with the told line. */
  readonly offers: boolean;
  /** The offer's words. */
  readonly offerLabel: string;
  /** A press of Send (or its chord) over the letter that went: sends nothing, and says why. */
  readonly tell: () => void;
  /** The offer pressed: the told line goes, and the composition's own send takes the words. */
  readonly sendAsNew: () => void;
}

/** `words` reads the composer's catalogue; `send` is the composition's own send. */
export function useWentElsewhere(
  e: ComposeElsewhere | null,
  words: (key: NoteKey | SendKey | OfferKey | DiscardKey) => string,
  send: () => void,
): WentElsewhere {
  const [told, setTold] = useState(false);
  useEffect(() => {
    if (e === null) setTold(false);
  }, [e]);
  const tell = useCallback(() => setTold(true), []);
  const sendAsNew = useCallback(() => {
    setTold(false);
    send();
  }, [send]);
  const offerLabel = words("sendAsNew");
  if (e === null)
    return {
      note: null,
      discardReason: null,
      refusal: null,
      told: false,
      offers: false,
      offerLabel,
      tell,
      sendAsNew,
    };
  return {
    note: words(elsewhereNoteKey(e)),
    discardReason: words(elsewhereDiscardKey(e)),
    refusal: words(elsewhereSendKey(e)),
    told,
    offers: offersAsNew(e),
    offerLabel,
    tell,
    sendAsNew,
  };
}
