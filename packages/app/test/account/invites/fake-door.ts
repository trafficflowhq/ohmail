import type { Answer } from "../../../src/account/contract.js";
import type { InvitesDoor, MadeInvite, OpenInvite } from "../../../src/account/invites/model.js";

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

/** An open invite for somebody named, and one for nobody. */
export const FOR_RAHEL: OpenInvite = {
  id: "i-1",
  name: "Rahel Beck",
  made: "10 Aug 2026",
  expires: "17 Aug 2026",
};
export const FOR_NOBODY: OpenInvite = { id: "i-2", name: null, made: "11 Aug 2026", expires: "18 Aug 2026" };

export interface FakeInvitesDoor extends InvitesDoor {
  /** Every call that reached the door, in order: its member's name, and what it was handed where that is no secret. */
  readonly calls: () => readonly string[];
  /** Every text `copy` was handed, as it was handed. */
  readonly copied: () => readonly string[];
}

/**
 * The account's invites the test stands in for. It refuses unless handed an answer: each member takes its answers
 * in turn, and a call with none left is refused with {@link NOT_HANDED} (the clipboard: not taken). It records what
 * reached it.
 */
export function fakeInvitesDoor(
  input: {
    readonly reads?: readonly Handed<readonly OpenInvite[]>[];
    readonly makes?: readonly Handed<MadeInvite>[];
    readonly revokes?: readonly Handed<null>[];
    readonly copies?: readonly (boolean | Promise<boolean> | typeof THROWS)[];
  } = {},
): FakeInvitesDoor {
  const calls: string[] = [];
  const copied: string[] = [];
  const answers = {
    read: [...(input.reads ?? [])],
    make: [...(input.makes ?? [])],
    revoke: [...(input.revokes ?? [])],
  };
  const copies = [...(input.copies ?? [])];
  function next<T>(member: keyof typeof answers, with_?: string): Promise<Answer<T>> {
    calls.push(with_ === undefined ? member : `${member}:${with_}`);
    const answer = (answers[member] as Handed<T>[]).shift() ?? REFUSES;
    return answer === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(answer);
  }
  return {
    read: () => next<readonly OpenInvite[]>("read"),
    make: (name) => next<MadeInvite>("make", name),
    revoke: (id) => next<null>("revoke", id),
    copy: (text) => {
      calls.push("copy");
      copied.push(text);
      const took = copies.shift() ?? false;
      return took === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(took);
    },
    calls: () => calls,
    copied: () => copied,
  };
}
