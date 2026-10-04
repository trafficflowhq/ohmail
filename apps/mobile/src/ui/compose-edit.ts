/**
 * A COMPOSER FIELD TAKES AN EDIT ONLY WHILE NOTHING IS BEING SENT. `editable={false}` does not stop
 * an input method still attached to the field from committing text (FREEZE-02513, on an APK): the
 * field showed words the send under way would not carry. Each field's change goes through this, so
 * outside `idle` the screen keeps the words that go. Driven directly by its test, as `send-cancel.ts`
 * is; `MessageActions.tsx` is read to prove every field takes it.
 */
import type { ComposerPhase } from "./send-cancel";

export function editWhileIdle<T>(phase: ComposerPhase, set: (value: T) => void): (value: T) => void {
  return (value) => { if (phase === "idle") set(value); };
}
