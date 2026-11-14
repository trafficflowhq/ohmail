/**
 * THE FIRST RUN's MAILBOX STEP IS THE ONE CONNECT FORM (`packages/app/src/mailboxes/connect`), and the form's model is
 * `connectStep` of app-logic. Today's `FirstRun.tsx` held its own form; the older first run's pins about what a
 * verdict or a refusal describes are asked here of the model the new step runs, walked the way its own tests walk it
 * (`packages/app-logic/test/mailboxes/connect/model.test.ts`).
 */
import {
  connectStep,
  initialState,
  type ConnectEvent,
  type ConnectFacts,
  type ConnectState,
  type Parked,
} from "@ohmail/app-logic/mailboxes/connect/model";
import { NO_DETAILS } from "@ohmail/app-logic/mailboxes/connect/refusal";
import { secretOf } from "@ohmail/app-logic/mailboxes/connect/secret";
import { WAYS_SHUT } from "@ohmail/app-logic/mailboxes/connect/sign-in";
import type { Answered, Refusal, RefusalDetails } from "@ohmail/app-logic/mailboxes/connect/types";

/** The first run's own mount of the form: no subject yet, a dialog for the second factor, no provider's sign-in. */
export const FIRST_RUN: ConnectFacts = { purpose: "firstRun", subject: null, factor: true, ways: WAYS_SHUT, code: false };

export const HOST_A = "mail-a.home.arpa";
export const HOST_B = "mail-b.home.arpa";

/** A press of the step: what the form froze to send. */
export const pressOf = (verb: Parked["verb"]): ConnectEvent => ({
  kind: "press",
  act: Object.freeze({
    verb,
    subject: null,
    mode: verb === "connect" ? "seed" : null,
    sent: { imap: HOST_A, smtp: HOST_A as string | null },
    body: Object.freeze({
      address: "a@example.org",
      provider: "imap",
      imap: Object.freeze({ host: HOST_A, pass: secretOf("zq-first-run-pass") }),
    }),
  }) as Parked,
});

export const typed = (
  field: "address" | "user" | "imapHost" | "smtpHost" | "imapPort" | "smtpPort",
  value: string,
): ConnectEvent => ({ kind: "typed", field, value });

export const refused = (code: string, details: Partial<RefusalDetails> = {}): Answered<never> => ({
  ok: false,
  refusal: { status: 422, code, message: "The server's own sentence.", details: { ...NO_DETAILS, ...details } } as Refusal,
});

/** The answer to the press on its way (the form's own sequence). */
export const answeredWith =
  (answer: Answered<unknown>) =>
  (s: ConnectState): ConnectEvent => ({ kind: "answered", seq: s.seq, answer });

/** Walk the events from a fresh form (or `from`); the state after the last. */
export function walkForm(
  events: readonly (ConnectEvent | ((s: ConnectState) => ConnectEvent))[],
  from?: ConnectState,
): ConnectState {
  let state = from ?? initialState(null, FIRST_RUN);
  for (const next of events) state = connectStep(state, typeof next === "function" ? next(state) : next, FIRST_RUN).state;
  return state;
}

/** What the form says under its fields, as a key (null: nothing said). */
export const saidKey = (state: ConnectState): string | null =>
  state.shown === null
    ? null
    : "server" in state.shown.said
      ? "server"
      : `${state.shown.said.ns}.${state.shown.said.key}`;
