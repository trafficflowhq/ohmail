import type { Answer } from "../../../src/account/contract.js";
import type { Enrolled, SecurityDoor } from "../../../src/account/security/model.js";

/** What a call with no answer left is told: the test handed none. */
export const NOT_HANDED = "The test handed this call no answer.";
const REFUSES = { ok: false, word: "said", said: NOT_HANDED } as const;
/** A door that breaks its promise and throws: no filling should, and the pane must still say something true. */
export const THROWS = "throws";

/** One answer of a member: a value, a promise the test settles, or a throw made at the call. */
export type Handed<T> = Answer<T> | Promise<Answer<T>> | typeof THROWS;

/** An answer the test settles by hand, so a case can look between the press and the server's word. */
export function held<T>(): { readonly promise: Promise<T>; settle(value: T): void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

export const ok = <T>(value: T): Answer<T> => ({ ok: true, value });
export const FACTOR = { ok: false, word: "factor" } as const;
export const SIGN_IN = { ok: false, word: "sign_in" } as const;
export const said = (sentence: string) => ({ ok: false, word: "said", said: sentence }) as const;

/** What an account can have enrolled, by the names the cases use. */
export const ENROLLED = {
  nothing: { passkey: false, authenticator: false, recoveryCodes: false },
  passkey: { passkey: true, authenticator: false, recoveryCodes: true },
  authenticator: { passkey: false, authenticator: true, recoveryCodes: true },
  both: { passkey: true, authenticator: true, recoveryCodes: true },
  noCodes: { passkey: true, authenticator: true, recoveryCodes: false },
} as const satisfies Record<string, Enrolled>;

export interface FakeSecurityDoor extends SecurityDoor {
  /** Every call that reached the door, in order, by its member's name. */
  readonly calls: () => readonly string[];
  /** Every code `activate` was handed, as it was handed. */
  readonly codes: () => readonly string[];
}

/**
 * The account's second factors the test stands in for. It refuses unless handed an answer: each member takes its
 * answers in turn, and a call with none left is refused with {@link NOT_HANDED}. It records what reached it.
 */
export function fakeSecurityDoor(
  input: {
    readonly reads?: readonly Handed<Enrolled>[];
    readonly newCodes?: readonly Handed<readonly string[]>[];
    readonly starts?: readonly Handed<{ readonly key: string }>[];
    readonly activates?: readonly Handed<null>[];
    readonly removes?: readonly Handed<null>[];
  } = {},
): FakeSecurityDoor {
  const calls: string[] = [];
  const codes: string[] = [];
  const answers = {
    read: [...(input.reads ?? [])],
    newCodes: [...(input.newCodes ?? [])],
    startAuthenticator: [...(input.starts ?? [])],
    activate: [...(input.activates ?? [])],
    removeAuthenticator: [...(input.removes ?? [])],
  };
  function next<T>(member: keyof typeof answers): Promise<Answer<T>> {
    calls.push(member);
    const answer = (answers[member] as Handed<T>[]).shift() ?? REFUSES;
    return answer === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(answer);
  }
  return {
    read: () => next<Enrolled>("read"),
    newCodes: () => next<readonly string[]>("newCodes"),
    startAuthenticator: () => next<{ readonly key: string }>("startAuthenticator"),
    activate: (code) => {
      codes.push(code);
      return next<null>("activate");
    },
    removeAuthenticator: () => next<null>("removeAuthenticator"),
    calls: () => calls,
    codes: () => codes,
  };
}
