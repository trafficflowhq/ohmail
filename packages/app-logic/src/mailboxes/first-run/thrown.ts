/**
 * WHAT A REFUSED WRITE OF THE STAGE SAYS. A shell's first-run verbs throw on a refusal; the throw is read field by
 * field by the one reader beside the connect form's rules (`connect/thrown.ts`), and said here in the stage's words.
 */
import { saidOf, type Said } from "../connect/refusal.js";
import { refusalOfThrown } from "../connect/thrown.js";

/** A sentence the stage itself says when a press ends refused: thrown by a write, said where it was pressed. */
export class StageRefusal {
  constructor(readonly said: Said) {}
}

/** A first-run sentence, by its key. */
export const onboarding = (key: string): Said => ({ ns: "onboarding", key });

/**
 * What a refused write says: the stage's own sentence where it threw one, else the one table's sentence for the
 * refusal (the server's own where no row words it). `factor`: a dialog could have been asked for it.
 */
export function saidOfThrown(thrown: unknown, factor: boolean): Said {
  if (thrown instanceof StageRefusal) return thrown.said;
  return saidOf(refusalOfThrown(thrown), {
    purpose: "firstRun",
    preset: null,
    manual: false,
    ports: false,
    signInArmed: false,
    afterFactor: false,
    factor,
  });
}
