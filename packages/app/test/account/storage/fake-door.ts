import type { Answer, StorageWord } from "../../../src/account/contract.js";
import type { StorageDoor, StorageFigures } from "../../../src/account/storage/model.js";

export type ChangeAnswer = Answer<"left", StorageWord>;

/** Figures as the reader says them, enough to draw: a test changes what it is about. */
export function someFigures(over: Partial<StorageFigures> = {}): StorageFigures {
  return {
    used: "235 MB",
    limit: "5 GB",
    room: { kind: "plan", limit: "5 GB" },
    tag: null,
    bar: {
      parts: [{ id: "all", from: 0, width: 0.047 }],
      rest: null,
      limit: { at: 1, said: "5 GB" },
      plan: null,
      expected: null,
      scale: "5 GB",
    },
    rows: [],
    total: null,
    needs: null,
    kept: null,
    plan: { kind: "keeps", limit: "5 GB", plan: null },
    plans: null,
    mail: true,
    ...over,
  };
}

/** An answer the test settles by hand, so a case can look between the press and the server's word. */
export function held<T>(): { readonly promise: Promise<T>; settle(value: T): void } {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

export interface FakeStorageDoor extends StorageDoor {
  /** Every value a press asked the server to write, in order. */
  readonly written: () => readonly boolean[];
  /** How many times the change was asked of the server. */
  readonly changed: () => number;
  /** A new access answer arrives: the figures it carries. */
  show(next: StorageFigures | null): void;
}

/** A door that breaks its promise and throws: no filling should, and the pane must still say something true. */
export const THROWS = "throws";

/** One answer in turn: a value, a promise the test settles, or a throw made at the call. */
function next<T>(answers: (T | Promise<T> | typeof THROWS)[], none: T): Promise<T> {
  const answer = answers.shift() ?? none;
  return answer === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(answer);
}

/**
 * The account's storage the test stands in for. It refuses unless handed an answer: a write with no answer left is
 * refused, and a change with no answer left did not leave. Each answer is taken in turn. It counts what reached it.
 */
export function fakeStorageDoor(
  input: {
    readonly figures?: StorageFigures | null;
    readonly writes?: readonly (boolean | Promise<boolean> | typeof THROWS)[];
    readonly changes?: readonly (ChangeAnswer | Promise<ChangeAnswer> | typeof THROWS)[];
  } = {},
): FakeStorageDoor {
  let figures = input.figures ?? null;
  const listeners = new Set<() => void>();
  const writes = [...(input.writes ?? [])];
  const changes = [...(input.changes ?? [])];
  const written: boolean[] = [];
  let changed = 0;
  return {
    figures: {
      read: () => figures,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setMail: (on) => {
      written.push(on);
      return next(writes, false);
    },
    change: () => {
      changed += 1;
      return next<ChangeAnswer>(changes, { ok: false, word: "failed" });
    },
    written: () => written,
    changed: () => changed,
    show: (next) => {
      figures = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
