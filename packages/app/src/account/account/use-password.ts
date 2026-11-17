import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gatedAsk } from "../gated.js";
import {
  PASSWORD_START,
  passwordCheck,
  passwordModelOf,
  passwordOwed,
  passwordStep,
  type PasswordDoor,
  type PasswordEvent,
  type PasswordModel,
  type PasswordTyped,
} from "./password.js";

/** A change that could not be sent, or that the door gave no answer to: it is said as not made. */
const NOT_MADE = { ok: false, word: "refused" } as const;

/**
 * The password form's model over its door. What was typed is checked first, in the server's own order, and a check
 * that fails sends nothing. The change is then TRIED; only the server's refusal asks the factor, whose verified
 * answer sends the same change once more; a second such refusal is the sign-in remedy.
 *
 * The two typed values are held here, in memory, and nowhere else: from the press until the server has answered,
 * and across the factor's dialog while the change is parked. They are dropped on Cancel, on a factor thrown away,
 * on every refusal and when the change lands. They are in no state, no model and no stored key.
 *
 * A form that was left sends nothing and steps nothing. The guard is armed in the effect, so a tree mounted twice
 * over still answers.
 */
export function usePassword(door: PasswordDoor): PasswordModel {
  /** The one place the state lives: each event is stepped from here as it arrives, never inside a state updater. */
  const held = useRef(PASSWORD_START);
  const [state, setState] = useState(PASSWORD_START);
  /** What the server is still owed: the two typed values of the change on its way or parked. */
  const owed = useRef<{ readonly current: string; readonly next: string } | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      owed.current = null;
    };
  }, []);

  const send = useCallback(
    function step(event: PasswordEvent): void {
      if (!alive.current) return;
      const next = passwordStep(held.current, event);
      held.current = next.state;
      setState(next.state);
      // Owed no longer, kept no longer.
      if (!passwordOwed(next.state)) owed.current = null;
      if (next.run === null) return;
      const typed = owed.current;
      if (typed === null) {
        step({ kind: "answered", answer: NOT_MADE });
        return;
      }
      void door.change(typed.current, typed.next).then(
        (answer) => step({ kind: "answered", answer }),
        () => step({ kind: "answered", answer: NOT_MADE }),
      );
    },
    [door],
  );

  const change = useCallback(
    (typed: PasswordTyped): void => {
      // While a change is on its way or its factor is asked, a press is not an attempt and replaces nothing.
      if (!alive.current || passwordOwed(held.current)) return;
      const check = passwordCheck(typed);
      if (check === null) owed.current = { current: typed.current, next: typed.next };
      send({ kind: "pressed", check });
    },
    [send],
  );

  const ask = useMemo(() => gatedAsk(state.gate, send), [state.gate, send]);
  return useMemo(() => passwordModelOf(state, ask, change), [state, ask, change]);
}
