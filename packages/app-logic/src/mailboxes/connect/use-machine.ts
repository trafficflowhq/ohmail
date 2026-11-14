"use client";

import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import { NONE, type ConnectFormInput, type PasswordHandle } from "./calls.js";
import { connectStep, initialState } from "./model.js";
import { NO_DETAILS, withoutEcho } from "./refusal.js";
import { echoes } from "./secret.js";
import type { ConnectEvent, ConnectFacts, ConnectState, Stepped } from "./state.js";
import type { Answered, ConnectInput, ConnectPatch, Refusal } from "./types.js";

/** No answer at all: what a wire that threw is read as. Its error is never read. */
export const NO_ANSWER: Refusal = Object.freeze({ status: 0, code: null, message: "", details: NO_DETAILS });

export interface Machine {
  /** The state as it is now, for a callback that runs later. */
  readonly held: RefObject<ConnectState>;
  readonly state: ConnectState;
  /** One event, applied where it arrived. */
  dispatch(event: ConnectEvent): void;
  /** Whether the form still stands. */
  readonly alive: RefObject<boolean>;
  /** The password field's handle is attached here. */
  readonly password: RefObject<PasswordHandle | null>;
  readonly hasPassword: boolean;
  passwordChanged(filled: boolean): void;
}

type Send = NonNullable<Stepped["send"]>;

/** One press, on the wire: its own verb, never another. A verb the shell does not have is no answer. */
async function wired(run: Send, door: ConnectFormInput["door"]): Promise<Answered<unknown>> {
  const { act } = run;
  if (act.verb === "test" && door.probe !== NONE) return door.probe(act.body as ConnectInput);
  if (act.verb === "connect" && act.mode !== null) return door.connect(act.body as ConnectInput, act.mode);
  if (act.verb === "edit" && act.subject !== null && door.edit !== NONE)
    return door.edit(act.subject, act.body as ConnectPatch);
  return { ok: false, refusal: NO_ANSWER };
}

/**
 * THE MACHINE, STEPPED. The state sits in a ref and each event is applied where it arrives, never inside a state
 * updater. A press a step hands back is sent once: whose browser this is first (the caller's guard), then the wire.
 * A form that left steps nothing and sends nothing; `alive` is armed in an effect.
 *
 * The password is not here: it stays in its field, reached through `password`. A step that ends a connect or an
 * edit tells the field to forget it, and so does a sign-in's press, before the shell is asked to leave.
 */
export function useMachine(input: ConnectFormInput, facts: ConnectFacts): Machine {
  const latest = useRef({ input, facts });
  latest.current = { input, facts };
  const held = useRef<ConnectState>(null as unknown as ConnectState);
  if (held.current === null) held.current = initialState(input.kept?.read() ?? null, facts);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [hasPassword, setHasPassword] = useState(false);
  const password = useRef<PasswordHandle | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const machine = useRef<{ dispatch(event: ConnectEvent): void; send(run: Send): Promise<void> } | null>(
    null,
  );
  if (machine.current === null) {
    const dispatch = (event: ConnectEvent): void => {
      if (!alive.current) return;
      const stepped = connectStep(held.current, event, latest.current.facts);
      held.current = stepped.state;
      latest.current.input.kept?.write(stepped.state.typed);
      if (stepped.forget) {
        password.current?.clear();
        setHasPassword(false);
      }
      redraw();
      if (stepped.send !== null) void send(stepped.send);
      if (stepped.done !== null) latest.current.input.onDone(stepped.done);
    };
    const send = async (run: Send): Promise<void> => {
      const { guard, door } = latest.current.input;
      if (guard && !(await guard.before())) return dispatch({ kind: "guarded", seq: run.seq });
      if (!alive.current) return;
      let answer: Answered<unknown>;
      try {
        answer = await wired(run, door);
      } catch {
        answer = { ok: false, refusal: NO_ANSWER };
      }
      // A server's words that repeat what was sent are never drawn.
      if (!answer.ok) {
        const sealed = run.act.body.imap.pass;
        answer = { ok: false, refusal: withoutEcho(answer.refusal, (text) => echoes(sealed, text)) };
      }
      dispatch({ kind: "answered", seq: run.seq, answer });
    };
    machine.current = { dispatch, send };
  }

  return {
    held,
    state: held.current,
    dispatch: machine.current.dispatch,
    alive,
    password,
    hasPassword,
    passwordChanged(filled) {
      setHasPassword(filled);
      machine.current?.dispatch({ kind: "password" });
    },
  };
}
