import type { AccountWord, Answer, PasswordWord, SignOutOutcome } from "../../../src/account/contract.js";
import type { AccountDoor } from "../../../src/account/account/model.js";
import type { PasswordDoor } from "../../../src/account/account/password.js";

/** What a call with no answer left is told: the test handed none. */
export const NOT_HANDED = "The test handed this call no answer.";
/** A door that breaks its promise and throws: no filling should, and the pane must still say something true. */
export const THROWS = "throws";

/** An answer the test settles by hand, so a case can look between the press and the server's word. */
export function held<T>(): { readonly promise: Promise<T>; settle(value: T): void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** One answer in turn: a value, a promise the test settles, or a throw made at the call. */
function next<T>(answers: (T | Promise<T> | typeof THROWS)[], none: T): Promise<T> {
  const answer = answers.shift() ?? none;
  return answer === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(answer);
}

export type ChangeAnswer = Answer<{ readonly ended: number }, PasswordWord>;
export const changed = (ended: number): ChangeAnswer => ({ ok: true, value: { ended } });
export const FACTOR = { ok: false, word: "factor" } as const;
export const SIGN_IN = { ok: false, word: "sign_in" } as const;

export interface FakePasswordDoor extends PasswordDoor {
  /** Every change that reached the door, in order: the two values it was handed. */
  readonly sent: () => readonly (readonly [current: string, next: string])[];
}

/**
 * The account's password the test stands in for. It refuses unless handed an answer: each change takes the next
 * answer in turn, and one with none left is refused. It records what reached it.
 */
export function fakePasswordDoor(
  answers: readonly (ChangeAnswer | Promise<ChangeAnswer> | typeof THROWS)[] = [],
): FakePasswordDoor {
  const left = [...answers];
  const sent: (readonly [string, string])[] = [];
  return {
    change: (current, next_) => {
      sent.push([current, next_]);
      return next<ChangeAnswer>(left, { ok: false, word: "refused" });
    },
    sent: () => sent,
  };
}

export type WhoAnswer = Answer<{ readonly address: string }, AccountWord>;
export const signedIn = (address: string): WhoAnswer => ({ ok: true, value: { address } });
export const SIGNED_OUT: WhoAnswer = { ok: false, word: "signed_out" };
export const unread = (said: string): WhoAnswer => ({ ok: false, word: "said", said });

export interface FakeAccountDoor extends AccountDoor {
  /** Every call that reached the door, in order, by its member's name. */
  readonly calls: () => readonly string[];
}

/**
 * The session the test stands in for. It refuses unless handed an answer: a read with none left is a read that
 * failed, and a sign-out with none left stays, blocked. It records what reached it.
 */
export function fakeAccountDoor(
  input: {
    readonly who?: readonly (WhoAnswer | Promise<WhoAnswer> | typeof THROWS)[];
    readonly signOuts?: readonly (SignOutOutcome | Promise<SignOutOutcome> | typeof THROWS)[];
  } = {},
): FakeAccountDoor {
  const who = [...(input.who ?? [])];
  const signOuts = [...(input.signOuts ?? [])];
  const calls: string[] = [];
  return {
    who: () => {
      calls.push("who");
      return next<WhoAnswer>(who, unread(NOT_HANDED));
    },
    signOut: () => {
      calls.push("signOut");
      return next<SignOutOutcome>(signOuts, "blocked");
    },
    toErase: () => {
      calls.push("toErase");
    },
    toSignIn: () => {
      calls.push("toSignIn");
    },
    calls: () => calls,
  };
}
