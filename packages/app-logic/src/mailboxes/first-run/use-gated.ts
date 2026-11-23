/**
 * THE STAGE'S ONE PARKED PRESS. Agree, "Organize here instead" and Start over's Forget are the first run's gated verbs:
 * each is TRIED first, and only the server's refusal asks the second factor. The press is parked as a value (the verb,
 * its mailbox captured at the press, its frozen body), never a closure; a verified factor sends that value once more,
 * as it was; Cancel empties the slot; a factor that lands after Cancel runs nothing and is said. One slot for the
 * stage: the account lane's machine (`connect/gate.ts`) holds the order, this hook only steps it where an event
 * arrives, never inside a state updater, and steps nothing after the stage left.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  GATED_IDLE,
  gatedAsk,
  gatedStep,
  type GatedAnswer,
  type GatedAsk,
  type GatedEvent,
  type GatedRun,
  type GatedState,
} from "../connect/gate.js";
import { movedPressEnds } from "../connect/gate-moved.js";
import type { MailboxId } from "../connect/types.js";
import type { OrganizeBody } from "./ground.js";

export type GatedAct =
  | {
      readonly verb: "agree";
      readonly mailboxId: MailboxId;
      readonly body: OrganizeBody;
      /** The window showed senders to screen: the pull is held for them once it stored. */
      readonly sweeps: boolean;
      /** The mailbox was a reader at the press: its Agree asked for a claim the gate still answers. */
      readonly reader: boolean;
    }
  | { readonly verb: "takeover"; readonly mailboxId: MailboxId }
  | { readonly verb: "forget"; readonly mailboxId: MailboxId };

/** The door's answer to a gated press: taken, the factor asked, sign in again, or refused in the stage's words. */
export type GatedOutcome = GatedAnswer<"refused">;

export interface Gated<A extends { readonly verb: string } = GatedAct> {
  readonly state: GatedState<A, "refused">;
  /** The press, tried now; a second press while one is out or parked is not taken. */
  press(act: A): void;
  /** What the dialog is handed while the factor is asked, and `null` otherwise. */
  readonly ask: GatedAsk | null;
  /**
   * Whatever changes what the parked press would send: the slot empties and the dialog closes. A press still on its
   * way is remembered as moved under: no factor is asked for it. A dialog may restrict the withdrawal to its own verb.
   */
  withdraw(verb?: A["verb"]): void;
}

export function useGated<A extends { readonly verb: string }>(
  send: (run: GatedRun<A>) => Promise<GatedOutcome>,
): Gated<A> {
  const state = useRef<GatedState<A, "refused">>(GATED_IDLE);
  /** What a press would send changed while one was on its way. */
  const moved = useRef(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const alive = useRef(false);
  const sender = useRef(send);
  sender.current = send;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      state.current = GATED_IDLE;
    };
  }, []);
  const step = useCallback((event: GatedEvent<A, "refused">): void => {
    if (!alive.current) return;
    const next = gatedStep(state.current, event);
    state.current = next.state;
    redraw();
    if (next.run === null) return;
    // Every send is of the stage as it stood at its press.
    moved.current = false;
    const answered = (answer: GatedOutcome): void => {
      // The stage moved while this press was on its way: no factor is asked for it, and nothing ran.
      const ended = alive.current ? movedPressEnds(state.current, moved.current, answer) : null;
      if (ended === null) return step({ kind: "answered", answer });
      state.current = ended;
      redraw();
    };
    void sender.current(next.run).then(answered, () => answered({ ok: false, word: "refused" }));
  }, []);
  const withdraw = useCallback(
    (verb?: A["verb"]) => {
      const pending = state.current;
      if (pending.at !== "asking" && pending.at !== "trying") return;
      if (verb !== undefined && pending.act.verb !== verb) return;
      if (pending.at === "asking") step({ kind: "cancelled" });
      else moved.current = true;
    },
    [step],
  );
  return {
    state: state.current,
    press: (act) => step({ kind: "try", act }),
    ask: gatedAsk(state.current, step),
    withdraw,
  };
}
