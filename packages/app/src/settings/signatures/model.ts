/**
 * Signatures' model: one signature per live mailbox, as the server confirmed it, and the write. The shell builds it
 * from the one consent instance every composer's signature block reads, and withholds the pane until the live read
 * has landed: an editor drawn before it would show empty text over a stored signature.
 */
import type { ReactNode } from "react";
import { isRichEmpty, type RichValue } from "@ohmail/app-logic/writing/rich-text";

export type { RichValue };

export interface SignaturesMailbox {
  readonly id: string;
  readonly address: string;
  /** The stored signature, as the server confirmed it. */
  readonly stored: RichValue;
  /** Another install organizes this mailbox and published this signature: it is read here, not written. */
  readonly reading: boolean;
  /** A takeover of this mailbox was asked: a refusal is said in its words. */
  readonly takeoverAsked: boolean;
}

/** What the editor slot is handed: today's rich editor fills it, the composer's own task replaces the filler. */
export interface SignatureEditorProps {
  readonly label: string;
  readonly value: RichValue;
  readonly placeholder: string;
  readonly editable: boolean;
  /** A preview: drawn as a message carries it, no tools. */
  readonly preview: boolean;
  readonly onChange: (value: RichValue) => void;
}

export interface SignaturesModel {
  readonly mailboxes: readonly SignaturesMailbox[];
  /** The consent row's write, as it stands: plain text, or markup with no text. */
  write(mailboxId: string, signature: string | null, signatureHtml?: string | null): Promise<unknown>;
  /** The sentence for a refused write, where the organizer refused it; null for the plain failure. */
  refusal(error: unknown, takeoverAsked: boolean): string | null;
  /** The shell's leave hold: while a draft is unsaved, a way out of the pane asks first. Returns its release. */
  holdLeave(ask: (leave: () => void) => void): () => void;
  readonly editor: (props: SignatureEditorProps) => ReactNode;
  /** A note about a change that travelled to this mailbox from another device, where one stands. */
  readonly changeNote: (mailboxId: string) => ReactNode;
}

/** A value as the write takes it: an empty one clears, plain text goes as text, formatted text as markup alone. */
export function signatureWrite(value: RichValue): [signature: string | null, signatureHtml?: string | null] {
  if (value.html === "") return [isRichEmpty(value) ? null : value.text];
  return [null, value.html];
}

export function isDirty(draft: RichValue | undefined, stored: RichValue): boolean {
  return draft !== undefined && (draft.text !== stored.text || draft.html !== stored.html);
}

export { isRichEmpty };
