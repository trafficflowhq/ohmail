"use client";

/**
 * THE PANE'S GATED VERBS, BEHIND THE ONE DIALOG: remove, erase and organize here. The server asks a fresh second
 * factor for exactly these; the pane steps the one machine of `connect/gate.ts` over them, in one slot.
 *
 * A press is TRIED first. Only the server's refusal parks it, as a value (the verb, the row's id captured at the
 * press, what was typed), and asks the factor; verified, the same value is sent once more. Cancel empties the slot;
 * a second refusal right after the factor says to sign in again. Nothing is sent on a default, a mount or a route.
 */
import { useEffect, useReducer, useRef } from "react";
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
import { NO_DETAILS, gateOf } from "../connect/refusal.js";
import type { Answered, MailboxId } from "../connect/types.js";
import { NONE, type PaneCalls } from "./calls.js";

/** A press parked as it was made: a value, never a closure. */
export type GatedAct =
  | { readonly verb: "remove"; readonly id: MailboxId; readonly address: string }
  | { readonly verb: "erase"; readonly id: MailboxId; readonly address: string; readonly typed: string }
  | { readonly verb: "organize"; readonly id: MailboxId };

/** The pane's own words a refusal can be said in: the typed address was not the mailbox's, or no sentence came. */
export type GatedWord = "mismatch" | "unknown";

export interface GatedInput {
  readonly wire: Pick<PaneCalls, "remove" | "erase" | "organizeHere">;
  /** A second factor's dialog can be asked here. Without one a closed window says to sign in again. */
  readonly factor: boolean;
  /** A press the server took: what it answered. */
  onTaken(act: GatedAct, value: unknown): void;
}

export interface Gated {
  readonly state: GatedState<GatedAct, GatedWord>;
  /** What the dialog is handed while the factor is asked; `null` otherwise. */
  readonly asking: GatedAsk | null;
  /** The person's press. A second while one is on its way or asked is not taken. */
  tryAct(act: GatedAct): void;
  /**
   * What changes what a press would send empties the slot: the dialog closes, nothing is sent. A press still on its
   * way is remembered as moved under: no factor is asked for it.
   */
  drop(): void;
}

const frozen = (act: GatedAct): GatedAct => Object.freeze({ ...act });

/** The wire's answer as the machine reads it. */
function answerOf(answer: Answered<unknown>, factor: boolean): GatedAnswer<GatedWord> {
  if (answer.ok) return { ok: true };
  const r = answer.refusal;
  const gate = gateOf(r);
  if (gate === "factor") return { ok: false, word: factor ? "factor" : "sign_in" };
  if (gate === "signIn") return { ok: false, word: "sign_in" };
  if (r.code === "erase_not_confirmed") return { ok: false, word: "mismatch" };
  return r.message !== "" ? { ok: false, word: "said", said: r.message } : { ok: false, word: "unknown" };
}

/** One press on the wire, its own verb and never another. A verb the shell does not have is no answer. */
function send(act: GatedAct, wire: GatedInput["wire"]): Promise<Answered<unknown>> {
  if (act.verb === "remove" && wire.remove !== NONE) return wire.remove(act.id);
  if (act.verb === "erase" && wire.erase !== NONE) return wire.erase(act.id, act.typed);
  if (act.verb === "organize" && wire.organizeHere !== NONE) return wire.organizeHere(act.id, {});
  return Promise.resolve({ ok: false, refusal: { status: 0, code: null, message: "", details: NO_DETAILS } });
}

/**
 * THE MACHINE, STEPPED where each event arrives and never inside a state updater, so a press a step hands back is
 * sent once. A pane that left steps nothing and sends nothing.
 */
export function useGated(input: GatedInput): Gated {
  const latest = useRef(input);
  latest.current = input;
  const held = useRef<GatedState<GatedAct, GatedWord>>(GATED_IDLE);
  /** What a press would send changed while one was on its way. */
  const moved = useRef(false);
  const alive = useRef(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const machine = useRef<{ step(event: GatedEvent<GatedAct, GatedWord>): void } | null>(null);
  if (machine.current === null) {
    const run = async (sent: GatedRun<GatedAct>): Promise<void> => {
      const answer = await send(sent.act, latest.current.wire);
      if (!alive.current) return;
      const before = held.current;
      const word = answerOf(answer, latest.current.factor);
      // The pane moved while this press was on its way: no factor is asked for it, and nothing ran.
      const ended = movedPressEnds(before, moved.current, word);
      if (ended !== null) {
        held.current = ended;
        return redraw();
      }
      step({ kind: "answered", answer: word });
      if (answer.ok && before.at === "trying" && held.current.at === "done")
        latest.current.onTaken(sent.act, answer.value);
    };
    const step = (event: GatedEvent<GatedAct, GatedWord>): void => {
      if (!alive.current) return;
      const stepped = gatedStep(held.current, event);
      held.current = stepped.state;
      redraw();
      if (stepped.run === null) return;
      // Every send is of the pane as it stood at its press.
      moved.current = false;
      void run(stepped.run);
    };
    machine.current = { step };
  }
  const { step } = machine.current;
  const state = held.current;
  return {
    state,
    asking: gatedAsk(state, step),
    tryAct: (act) => step({ kind: "try", act: frozen(act) }),
    drop: () => {
      // Whatever changed what a press would send: the parked one goes, as Cancel would take it; one still on its
      // way cannot be called back, and is remembered as moved under.
      if (held.current.at === "asking") step({ kind: "cancelled" });
      else if (held.current.at === "trying") moved.current = true;
    },
  };
}
