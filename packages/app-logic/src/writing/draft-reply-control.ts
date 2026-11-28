/**
 * The drafted reply's control as its callers read it: the shape `useDraftReply` answers (`draft-reply.ts`, which
 * re-exports these names), and the person's own text kept beside a draft that landed over it. Types only.
 */

import type { RichValue } from "./rich-text.js";

/**
 * `closed` — the verb is idle.
 * `offered` — the cost is on screen and nothing has been spent.
 * `running` — the request is in flight.
 */
export type DraftReplyPhase = "closed" | "offered" | "running";

export interface DraftReplyControl {
  /**
   * The host handed a draft wire: the reply's draft control is drawn. Always true here: a host that answers `none`
   * is answered no control at all (`null`), so nothing is drawn, nothing is offered and nothing can be asked.
   */
  offered: true;
  phase: DraftReplyPhase;
  /** Provisional text for this message while the draft is being written. */
  preview?: string;
  /** The message the offer is about, so a stale offer cannot be confirmed against another. */
  messageId: string | null;
  /** What one press costs, in CREDITS. Stated before {@link confirm} is reachable. */
  cost: number;
  /** One sentence about the current state, already translated, or null. */
  notice: string | null;
  /** Offer to draft a reply to this message. Spends nothing. */
  open: (messageId: string) => void;
  cancel: () => void;
  /** Spend, and hand the result to `onDraft`. */
  confirm: () => void;
  /**
   * The offer and the purchase in one press, for a control that states its cost on itself. Pressed again for the
   * same message after a failure it retries that purchase with its key; a press while one runs does nothing. `own` is
   * the person's own text in that reply as the press found it: kept as {@link own} once the draft lands over it.
   * Returns whether the purchase started, as do {@link fromText} and {@link letter}.
   */
  press: (messageId: string, own: RichValue, fullConversation?: boolean) => boolean;
  /**
   * A draft made of the person's own words in the reply to this message, in one press, as {@link press} is: one key
   * per press, the same words pressed again after a failure retry that purchase, a press while one runs does nothing.
   * `none` where the host has no door for it: the control does not offer it.
   */
  fromText:
    ((messageId: string, text: string, own: RichValue, fullConversation?: boolean) => boolean) | "none";
  /**
   * A new letter drafted from the person's own words: the words, the address it goes from and its subject, as
   * {@link fromText} is pressed. `none` exactly when {@link fromText} is.
   */
  letter:
    | ((words: { text: string; mailboxId: string | null; subject: string }, own: RichValue) => boolean)
    | "none";
  /** {@link NEW_LETTER}: the new letter's `messageId` while its draft is out. */
  letterId: string;
  /**
   * The person's own text in each reply a draft landed over, and that draft: the reply's two tabs, by the letter's
   * id. Kept here, in memory only, until a send of that reply settles or the reply is discarded (a reload drops it);
   * a draft on another letter never touches it.
   */
  own: ReadonlyMap<string, OwnText>;
  /** The two texts as they stand now, kept for their letter when the person changes tabs. */
  keep: (own: OwnText) => void;
  /** That reply was sent or discarded: its own text is let go. */
  forget: (messageId: string) => void;
  /**
   * The new letter left the composer (another letter took its place, or it was sent or discarded): its own text is let
   * go, and a draft still out for it fills no letter; it stays in Drafts, and the notice says so.
   */
  moved: (messageId: string) => void;
  /** A discard of that reply or letter was undone: a draft still out for it lands, keeping the words its press handed. */
  restore: (messageId: string) => void;
}

/** The person's own text beside the draft that landed over it, and which version is visible. */
export interface DraftVersions {
  readonly yours: RichValue;
  readonly draft: RichValue;
  readonly shown: "yours" | "draft";
}

export interface OwnText extends DraftVersions {
  readonly messageId: string;
}
