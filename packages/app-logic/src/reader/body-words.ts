/**
 * WHICH SENTENCE A LETTER'S TEXT STATE GETS (`body.*`): each reason the text is not here says its own, and a
 * verdict's husk on a letter moved out of Junk is text on its way. The reader does not know a mailbox stood down, so
 * the storage cap says the plain sentence.
 */
import {
  isJunkHuskLeaving,
  isProtectedMessage,
  type EngineMessage,
  type MessageBody,
} from "@ohmail/client-engine";

export type WithheldKey =
  "withheld" | "withheldJunk" | "withheldJunkLoading" | "withheldExpunged" | "withheldTooLarge";

export function withheldKeyOf(
  body: Pick<MessageBody, "state" | "withheld">,
  folder: string | null | undefined,
): WithheldKey {
  switch (body.withheld) {
    case "junk_filed":
      return isJunkHuskLeaving(body, folder) ? "withheldJunkLoading" : "withheldJunk";
    case "expunged":
      return "withheldExpunged";
    case "too_large":
      return "withheldTooLarge";
    default:
      return "withheld";
  }
}

/** Emptied for space: the one withheld text the mail server can hand this view again ("Load it now"). */
export const emptiedForSpace = (body: Pick<MessageBody, "state" | "withheld">): boolean =>
  body.state === "withheld" && (body.withheld === "storage_cap" || body.withheld == null);

/** A letter whose text is final for the read rule: its whole text, the sentence that stands for it, or its code's guard. */
export const letterReady = (m: EngineMessage, body: Pick<MessageBody, "state">): boolean =>
  body.state === "full" || body.state === "withheld" || isProtectedMessage(m);

/** A verification code's letter: its text never stands in the column. */
export const isProtected = (m: EngineMessage): boolean => isProtectedMessage(m);
