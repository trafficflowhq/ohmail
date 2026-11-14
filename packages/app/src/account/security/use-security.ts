import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gatedAsk, type GatedAnswer } from "../gated.js";
import {
  SECURITY_START,
  securityModelOf,
  securityStep,
  type SecurityAct,
  type SecurityDoor,
  type SecurityEvent,
  type SecurityModel,
} from "./model.js";

const TAKEN = { ok: true } as const;
/** A door that gave no answer at all: nothing is known, so nothing is claimed beyond "it did not go through". */
const UNANSWERED = { ok: false, word: "said", said: "" } as const;

/**
 * Security's model over its door. Opening it reads what is enrolled, once. Every verb is TRIED first; only the
 * server's refusal asks the factor, whose verified answer sends the parked verb once more; a second such refusal is
 * the sign-in remedy. After a verb that changes what is enrolled the read is asked again, as the next call.
 *
 * A pane that was left sends nothing and steps nothing. The guard is armed in the effect, so a tree mounted twice
 * over still reads.
 */
export function useSecurity(door: SecurityDoor): SecurityModel {
  /** The one place the state lives: each event is stepped from here as it arrives, never inside a state updater. */
  const held = useRef(SECURITY_START);
  const [state, setState] = useState(SECURITY_START);
  const alive = useRef(false);

  const send = useCallback(
    function step(event: SecurityEvent): void {
      if (!alive.current) return;
      const next = securityStep(held.current, event);
      held.current = next.state;
      setState(next.state);
      if (next.run === null) return;

      /** What is enrolled, asked again after a verb that changed it. A pane that was left asks nothing. */
      const readAgain = async (): Promise<void> => {
        if (!alive.current) return;
        // The verb was taken whatever this read says: a read that gave no answer is a read that failed.
        step({ kind: "read", answer: await door.read().catch(() => UNANSWERED) });
      };
      /** The door's call for a verb, and what follows a verb that was taken. */
      const perform = async (act: SecurityAct): Promise<GatedAnswer> => {
        switch (act.kind) {
          case "newCodes": {
            const made = await door.newCodes();
            if (!made.ok) return made;
            step({ kind: "made", codes: made.value });
            await readAgain();
            return TAKEN;
          }
          case "startAuthenticator": {
            const started = await door.startAuthenticator();
            if (!started.ok) return started;
            step({ kind: "started", key: started.value.key });
            return TAKEN;
          }
          case "activate": {
            const taken = await door.activate(act.code);
            if (!taken.ok) return taken;
            step({ kind: "activated" });
            await readAgain();
            return TAKEN;
          }
          case "removeAuthenticator": {
            const taken = await door.removeAuthenticator();
            if (!taken.ok) return taken;
            await readAgain();
            return TAKEN;
          }
        }
      };
      void perform(next.run.act).then(
        (answer) => step({ kind: "answered", answer }),
        () => step({ kind: "answered", answer: UNANSWERED }),
      );
    },
    [door],
  );

  useEffect(() => {
    alive.current = true;
    void door.read().then(
      (answer) => send({ kind: "read", answer }),
      () => send({ kind: "read", answer: UNANSWERED }),
    );
    return () => {
      alive.current = false;
    };
  }, [door, send]);

  const ask = useMemo(() => gatedAsk(state.gate, send), [state.gate, send]);
  return useMemo(() => securityModelOf(state, ask, send), [state, ask, send]);
}
