import type { Answer } from "../../../src/account/contract.js";
import type {
  DeviceSession,
  DevicesDoor,
  DevicesLists,
  MadeLink,
  PairingCode,
} from "../../../src/account/devices/model.js";

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

/** This browser's own session: a plain sign-in nobody named. */
export const THIS: DeviceSession = {
  id: "s-this",
  kind: "web",
  name: { by: "nobody" },
  current: true,
  plainWeb: true,
  added: "1 Aug 2026",
  seen: "20 Aug 2026",
};
/** A paired phone its owner named. */
export const PHONE: DeviceSession = {
  id: "d-phone",
  kind: "android",
  name: { by: "person", said: "Mila's phone" },
  current: false,
  plainWeb: false,
  added: "10 Aug 2026",
  seen: "19 Aug 2026",
};
/** A desktop app that paired without a name: ohmail's own word names it. */
export const LAPTOP: DeviceSession = {
  id: "d-laptop",
  kind: "linux",
  name: { by: "ohmail" },
  current: false,
  plainWeb: false,
  added: "11 Aug 2026",
  seen: "18 Aug 2026",
};
/** Another plain browser sign-in, last seen on its own day. */
export const plain = (n: number): DeviceSession => ({
  id: `s-${n}`,
  kind: "web",
  name: { by: "nobody" },
  current: false,
  plainWeb: true,
  added: "1 Jul 2026",
  seen: `${n} Aug 2026`,
});
export const CODE: PairingCode = { id: "c-1", name: "Ben", until: "09:29" };
export const lists = (
  sessions: readonly DeviceSession[] = [THIS, PHONE],
  codes: readonly PairingCode[] = [],
): DevicesLists => ({ sessions, codes });

export interface FakeDevicesDoor extends DevicesDoor {
  /** Every call that reached the door, in order: its member's name, and what it was handed where that is no secret. */
  readonly calls: () => readonly string[];
  /** Every text `copy` was handed, as it was handed. */
  readonly copied: () => readonly string[];
}

/**
 * The account's devices the test stands in for. It refuses unless handed an answer: each member takes its answers
 * in turn, and a call with none left is refused with {@link NOT_HANDED} (the clipboard: not taken; the flavour: not
 * known). It records what reached it.
 */
export function fakeDevicesDoor(
  input: {
    readonly reads?: readonly Handed<DevicesLists>[];
    readonly groups?: boolean | Promise<boolean> | typeof THROWS;
    readonly adds?: readonly Handed<MadeLink>[];
    readonly revokes?: readonly Handed<null>[];
    readonly removes?: readonly Handed<null>[];
    readonly signOuts?: readonly Handed<{ readonly ended: number }>[];
    readonly copies?: readonly (boolean | Promise<boolean> | typeof THROWS)[];
  } = {},
): FakeDevicesDoor {
  const calls: string[] = [];
  const copied: string[] = [];
  const answers = {
    read: [...(input.reads ?? [])],
    add: [...(input.adds ?? [])],
    revokeCode: [...(input.revokes ?? [])],
    remove: [...(input.removes ?? [])],
    signOutWeb: [...(input.signOuts ?? [])],
  };
  const copies = [...(input.copies ?? [])];
  function next<T>(member: keyof typeof answers, with_?: string): Promise<Answer<T>> {
    calls.push(with_ === undefined ? member : `${member}:${with_}`);
    const answer = (answers[member] as Handed<T>[]).shift() ?? REFUSES;
    return answer === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(answer);
  }
  return {
    read: () => next<DevicesLists>("read"),
    groupsWebSessions: () => {
      calls.push("groupsWebSessions");
      const groups = input.groups ?? false;
      return groups === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(groups);
    },
    add: (name) => next<MadeLink>("add", name),
    revokeCode: (id) => next<null>("revokeCode", id),
    remove: (id) => next<null>("remove", id),
    signOutWeb: () => next<{ readonly ended: number }>("signOutWeb"),
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
