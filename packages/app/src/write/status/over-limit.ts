/**
 * PAST THE DRAFT CEILING, SAID: the autosave stops writing words past it (`reply-autosave.ts`, `compose-autosave.ts`:
 * `draftNoteKey`, the same predicate), so the line under the editor says so while the person types; Send rests and
 * stays pressable, and its press (or the chord) sends nothing and says why. The line goes the moment the words are
 * short enough again. Today's reply and composer said both, in this order.
 */
import { useCallback, useEffect, useState } from "react";
import { draftNoteKey } from "@ohmail/app-logic/writing/compose-autosave";

export interface OverLimit {
  /** The send's gate refuses the letter for its length alone: Send rests, pressable, and its press is `refused`. */
  readonly tooLong: boolean;
  /** What the line under the editor says: why a press sent nothing, else that the words are not saved; else null. */
  readonly line: string | null;
  /** A press of Send (or its chord) refused for the length: the line says why it sent nothing. */
  readonly refused: () => void;
}

/**
 * `refusal`: the send's own gate as it reads the letter now; `held`: something else holds Send (a file still being
 * read, a lock), and then its own line speaks; `words`: what the autosave weighs. The two sentences are read only
 * when said.
 */
export function useOverLimit(
  gate: {
    readonly refusal: string | null;
    readonly held: boolean;
    readonly words: { readonly body: string; readonly html: string };
  },
  said: { readonly send: () => string; readonly save: () => string },
): OverLimit {
  const tooLong = !gate.held && gate.refusal === "too_long";
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (!tooLong) setPressed(false);
  }, [tooLong]);
  const refused = useCallback(() => setPressed(true), []);
  const over = draftNoteKey(gate.words) === "bodyTooLong";
  const line = pressed && tooLong ? said.send() : over ? said.save() : null;
  return { tooLong, line, refused };
}
