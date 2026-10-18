/**
 * WHAT A SCREEN-OUT PRESS SAYS ABOUT THE ONE-CLICK UNSUBSCRIBE, BEFORE THE PRESS — one decider for
 * every surface (web card, row, bulk and sheet; the desktop; the phone's sheet and toasts).
 *
 * The server asks for the SENDER, not for the letters on screen: the press's own moves, the past-mail
 * pass and the hourly drain all send for any of their mail that offers one-click and whose provider
 * confirmed the sender. So an armed press always says the sender-level condition (`may_send`), and a
 * held letter seen offering one-click from a confirmed sender (`authVerdict` `pass`) strengthens it
 * (`sends`); any other verdict, or none, never does. `none` is the caller's alone: the account's
 * switch off, a door that sends nothing, no mailbox whose provider's word is read
 * ({@link autoUnsubscribeConfirms}), or a press that does not reach the decide route.
 */
import type { EntityReader } from "./store.js";
import type { EngineMessage, MessageBodyRecord, UnsubscribeHeaderState } from "./types.js";

export type UnsubscribeClaim = "sends" | "may_send" | "none";

/** One held letter as the claim reads it: its one-click posture and what its provider said of its author. */
export interface UnsubscribeLetter {
  /** `null` while its body is unread. */
  posture: UnsubscribeHeaderState | null;
  authVerdict: EngineMessage["authVerdict"];
}

export function unsubscribeClaim(o: {
  armed: boolean;
  /** The held letters the client can read. */
  letters: readonly UnsubscribeLetter[];
}): UnsubscribeClaim {
  if (!o.armed) return "none";
  return o.letters.some((l) => l.posture === "one_click" && l.authVerdict === "pass") ? "sends" : "may_send";
}

/**
 * One letter's posture as the server stated it, or `null` when no answer carrying it is held: a body
 * not yet read, still loading, failed, or written by a build that predates the field. `bodyOf`'s
 * `"no_header"` default is right for an action and wrong here, where it would silence a claim.
 */
export function unsubscribePostureOf(reader: EntityReader, messageId: string): UnsubscribeHeaderState | null {
  const rec = reader.get<MessageBodyRecord>("message_body", messageId);
  if (!rec || rec.state !== "ready" || typeof rec.unsubscribe !== "string") return null;
  return rec.unsubscribe;
}

/**
 * Can a screen-out on this account unsubscribe by itself at all: some mailbox not disconnected has a
 * provider whose word on a sender ohmail reads (`MailboxDTO.providerConfirms`). Where none has, every
 * verdict is `unavailable` and the server makes no automatic request, so the caller's press is not
 * armed. `null` (not read yet) and a row that cannot say answer yes: the failure to avoid is an
 * unsubscribe nobody was told about.
 */
export function autoUnsubscribeConfirms(
  mailboxes: readonly { status?: string | null; providerConfirms?: boolean }[] | null,
): boolean {
  if (mailboxes === null) return true;
  return mailboxes.some((m) => m.status !== "disabled" && m.providerConfirms !== false);
}

/** One held letter off the mirror, as {@link unsubscribeClaim} reads it. */
export function unsubscribeLetterOf(reader: EntityReader, messageId: string): UnsubscribeLetter {
  return {
    posture: unsubscribePostureOf(reader, messageId),
    authVerdict: reader.get<EngineMessage>("message", messageId)?.authVerdict ?? null,
  };
}
