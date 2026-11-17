/**
 * The password change, as data: for somebody told their password is known. The form draws a {@link PasswordModel}
 * and holds the three typed values itself; its hook checks what was typed, tries the change through a
 * {@link PasswordDoor}, and parks it behind the group's one gated machine when the server asks for the factor.
 *
 * The typed values are the secret here. They live in the form while they are typed and in the hook's memory while
 * the factor is asked; they are part of no model, no sentence and no stored key, and every attempt empties the form.
 * The wall mounts this form alone, so a closed account can still take back a password somebody else knows.
 */
import type { Answer, GatedAsk, PasswordWord } from "../contract.js";
import {
  GATED_IDLE,
  gatedStep,
  type GatedDialogEvent,
  type GatedRefusal,
  type GatedRun,
  type GatedState,
} from "../gated.js";

/** How a host changes the account's password. */
export interface PasswordDoor {
  /**
   * One request, whose body is the two typed values. The server checks the current password first and ends every
   * other session when it changes; `ended` is how many.
   */
  change(current: string, next: string): Promise<Answer<{ readonly ended: number }, PasswordWord>>;
}

/** What is said before anything is sent, in the order it is checked. Each is its catalogue key. */
export type PasswordCheck =
  /** No current one was typed. */
  | "needCurrent"
  /** The new one and its repeat differ. */
  | "mismatch"
  /** Under twelve, counted in code points. */
  | "tooShort"
  /** Over 256, counted in code points. */
  | "tooLong"
  /** The new one is the current one. */
  | "same";

/** What the form hands its hook on a press: the three fields as typed. */
export interface PasswordTyped {
  readonly current: string;
  readonly next: string;
  readonly again: string;
}

/** What the form draws. It holds no typed value. */
export interface PasswordModel {
  /** The change is on its way: the form is off. */
  readonly sending: boolean;
  /** Why the last attempt changed nothing: a typed check, or the server's word. */
  readonly refusal: { readonly word: PasswordCheck } | GatedRefusal<PasswordWord> | null;
  /** The last change landed: how many other sessions it signed out. */
  readonly changed: { readonly ended: number } | null;
  /** A factor landed after Cancel: nothing was changed. */
  readonly nothingChanged: boolean;
  /** The factor is asked. The form says, as it hands this on, that the change leaves the moment it verifies. */
  readonly ask: GatedAsk | null;
  /** One attempt. The form empties its three fields as it calls this, whatever comes of it. */
  change(typed: PasswordTyped): void;
}

/** The server's rule for a new one, said before anything is sent. Both are counted in code points. */
export const MIN_LENGTH = 12;
export const MAX_LENGTH = 256;

/**
 * What was typed, checked before anything is sent, in this order: no current one; the two new ones differ; under
 * twelve or over 256, counted in code points (a character outside the basic plane is one, as the server counts it);
 * the same as the current. `null`: it may be sent.
 */
export function passwordCheck(typed: PasswordTyped): PasswordCheck | null {
  const length = [...typed.next].length;
  if (typed.current.length === 0) return "needCurrent";
  if (typed.next !== typed.again) return "mismatch";
  if (length < MIN_LENGTH) return "tooShort";
  if (length > MAX_LENGTH) return "tooLong";
  if (typed.next === typed.current) return "same";
  return null;
}

/** The one gated act. The typed values never ride it: they stay in the hook's memory. */
export type PasswordAct = "change";

/** The form's state: the gated change, what a typed check said, and the last change that landed. */
export interface PasswordState {
  readonly gate: GatedState<PasswordAct, PasswordWord>;
  readonly check: PasswordCheck | null;
  readonly changed: { readonly ended: number } | null;
}

export type PasswordEvent =
  /** The person's press, with what the typed check said of it. */
  | { readonly kind: "pressed"; readonly check: PasswordCheck | null }
  /** The door answered the change on its way. */
  | { readonly kind: "answered"; readonly answer: Answer<{ readonly ended: number }, PasswordWord> }
  | GatedDialogEvent;

export interface PasswordStepped {
  readonly state: PasswordState;
  /** The change to send now, once; `null` where the event sends nothing. */
  readonly run: GatedRun<PasswordAct> | null;
}

export const PASSWORD_START: PasswordState = { gate: GATED_IDLE, check: null, changed: null };

/** Whether the typed values are still owed to the server: only while the change is on its way or parked. */
export const passwordOwed = (state: PasswordState): boolean =>
  state.gate.at === "trying" || state.gate.at === "asking";

/** One event, applied: the state after it, and whether the change is to be sent now. */
export function passwordStep(state: PasswordState, event: PasswordEvent): PasswordStepped {
  switch (event.kind) {
    case "pressed": {
      // While a change is on its way or its factor is asked, a press is not an attempt.
      if (passwordOwed(state)) return { state, run: null };
      // Every attempt starts clean: what the last one said or did is no longer said.
      if (event.check !== null) {
        return { state: { gate: GATED_IDLE, check: event.check, changed: null }, run: null };
      }
      const { state: gate, run } = gatedStep<PasswordAct, PasswordWord>(state.gate, {
        kind: "try",
        act: "change",
      });
      return { state: { gate, check: null, changed: null }, run };
    }
    case "answered": {
      const { answer } = event;
      const { state: gate } = gatedStep(state.gate, { kind: "answered", answer });
      // Only the change that was on its way lands; an answer nobody waits for changes nothing.
      if (gate.at !== "done") return { state: { ...state, gate }, run: null };
      const changed = answer.ok ? { ended: answer.value.ended } : null;
      return {
        state: { gate: { at: "idle", nothingRan: gate.nothingRan }, check: null, changed },
        run: null,
      };
    }
    default: {
      const { state: gate, run } = gatedStep(state.gate, event);
      return { state: { ...state, gate }, run };
    }
  }
}

/** The model a state draws, with the factor's ask and the verb the hook hands in. */
export function passwordModelOf(
  state: PasswordState,
  ask: GatedAsk | null,
  change: (typed: PasswordTyped) => void,
): PasswordModel {
  const { gate, check } = state;
  return {
    sending: gate.at === "trying",
    refusal: check !== null ? { word: check } : gate.at === "refused" ? gate.refusal : null,
    changed: state.changed,
    nothingChanged: gate.nothingRan,
    ask,
    change,
  };
}
