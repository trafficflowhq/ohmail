import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  accountStart,
  accountStep,
  type AccountBody,
  type AccountDoor,
  type AccountEvent,
  type AccountModel,
} from "./model.js";

/** A read the door gave no answer to: a read that failed, with nothing more to say of it. */
const UNREAD = { ok: false, word: "said", said: "" } as const;

/**
 * Account's model over its door. The whole pane asks who is signed in as it opens, once; the sign-out that stands
 * alone asks nobody. Sign-out goes to the door as it is: no factor is asked for it, here or anywhere. The erase is
 * not here: its verb leaves for the page that asks the factor on every press.
 *
 * A pane that was left steps nothing. The guard is armed in the effect, so a tree mounted twice over still reads.
 */
export function useAccount(door: AccountDoor, body: AccountBody = "pane"): AccountModel {
  /** The one place the state lives: each event is stepped from here as it arrives, never inside a state updater. */
  const held = useRef(accountStart(body));
  const [state, setState] = useState(held.current);
  const alive = useRef(false);

  const send = useCallback(
    function step(event: AccountEvent): void {
      if (!alive.current) return;
      const next = accountStep(body, held.current, event);
      held.current = next.state;
      setState(next.state);
      if (!next.signOut) return;
      void door.signOut().then(
        (outcome) => step({ kind: "signedOut", outcome }),
        // A door that gave no answer: nothing is known of this browser's copy, so it stays and says so.
        () => step({ kind: "signedOut", outcome: "unverified" }),
      );
    },
    [door, body],
  );

  useEffect(() => {
    alive.current = true;
    if (body === "pane") {
      void door.who().then(
        (answer) => send({ kind: "who", answer }),
        () => send({ kind: "who", answer: UNREAD }),
      );
    }
    return () => {
      alive.current = false;
    };
  }, [door, body, send]);

  return useMemo(
    () => ({
      ...state,
      signOut: () => send({ kind: "signOut" }),
      confirmSignOut: () => send({ kind: "confirmSignOut" }),
      cancelSignOut: () => send({ kind: "cancelSignOut" }),
      toErase: () => door.toErase(),
      toSignIn: () => door.toSignIn(),
    }),
    [state, send, door],
  );
}
