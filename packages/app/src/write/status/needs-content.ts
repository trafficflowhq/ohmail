/**
 * NOTHING TO SEND, SAID: with no words and no file (and not a forward), the send's own gate refuses the letter
 * (`needs_content`). Send stays a control a person reaches: pressable, said as off, its hint the reason; its press (or
 * the chord) sends nothing and says the reason under the editor, until there is something to send. Today's reply and
 * composer said it so.
 */
import { useCallback, useEffect, useState } from "react";

export interface NeedsContent {
  /** The send's gate refuses the letter for want of anything to send: Send's hint is `said`, and its press `told`. */
  readonly empty: boolean;
  /** What the line under the editor says once a press was refused for want of content; else null. */
  readonly line: string | null;
  /** A press of Send (or its chord) refused for want of content: the line says why it sent nothing. */
  readonly told: () => void;
}

/** `refusal`: the send's own gate as it reads the letter now; `held`: something else holds Send, and its own line speaks. */
export function useNeedsContent(
  gate: { readonly refusal: string | null; readonly held: boolean },
  said: string,
): NeedsContent {
  const empty = !gate.held && gate.refusal === "needs_content";
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (!empty) setPressed(false);
  }, [empty]);
  const told = useCallback(() => setPressed(true), []);
  return { empty, line: pressed && empty ? said : null, told };
}
