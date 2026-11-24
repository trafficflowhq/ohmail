/**
 * A PRESS THE PLACE MOVED UNDER. Whatever changes what a press would send withdraws a press that waits on the second
 * factor: either a parked press equals what the place would send now, or there is none. A press still on its way
 * cannot be called back, so the place remembers that it moved (`moved`, set while the gate is trying and reset by
 * every send). If the server then asks the factor for that press, no factor is asked: nothing is parked, the press
 * ends as "nothing ran", and the next press tries the place as it stands.
 *
 * One rule, asked here by the form's machine (`model.ts`), the pane's gated verbs (`pane/use-gated.ts`) and the
 * stage's (`first-run/use-gated.ts`), each where the door's answer arrives and before the machine of `gate.ts` is
 * stepped with it. That machine is as it was.
 */
import type { GatedAnswer, GatedState } from "./gate.js";

/**
 * The gate after `answer`, where the answer asks the factor for a press the place moved under before any factor was
 * given: nothing ran. `null` everywhere else: the machine steps as ever (a factor asked again right after a verified
 * one is the sign-in remedy, moved or not).
 */
export function movedPressEnds<A, W extends string = never>(
  gate: GatedState<A, W>,
  moved: boolean,
  // The place's own words are the gate's: the answer names none of its own.
  answer: GatedAnswer<NoInfer<W>>,
): GatedState<A, W> | null {
  const asksFactor = !answer.ok && answer.word === "factor";
  return asksFactor && moved && gate.at === "trying" && !gate.afterFactor
    ? { at: "idle", nothingRan: true }
    : null;
}
