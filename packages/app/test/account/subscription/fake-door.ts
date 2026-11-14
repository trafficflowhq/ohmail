import type { Answer, ManageOutcome, SubscriptionWord } from "../../../src/account/contract.js";
import { NONE, type None } from "../../../src/host/index.js";
import type {
  PlanPick,
  PlansAnswer,
  SubscriptionDoor,
  SubscriptionStatus,
} from "../../../src/account/subscription/model.js";

export type PlansRead = Answer<PlansAnswer, SubscriptionWord>;

/** A door that breaks its promise and throws: no filling should, and the pane must still say something true. */
export const THROWS = "throws";

/** The wire's four answers to the plans' read, as the door hands them on. Amounts are the test's own. */
export const READS = {
  /** `{ metered: false }`: nothing is for sale on this server. */
  notForSale: { ok: true, value: { kind: "notForSale" } },
  /** `card: null`: the billing program did not answer. */
  unanswered: { ok: true, value: { kind: "unanswered" } },
  /** `plans_unavailable`. */
  unavailable: { ok: false, word: "plans_unavailable" },
  /** A card: three plans, the add-on, the account on Plus by the month. */
  card: {
    ok: true,
    value: {
      kind: "plans",
      plans: [
        { plan: "solo", mailboxes: 2, credits: 1_000, storage: "2 GB", price: { month: "$9", year: "$90" } },
        {
          plan: "plus",
          mailboxes: 5,
          credits: 2_000,
          storage: "5 GB",
          price: { month: "$15", year: "$150" },
        },
        { plan: "pro", mailboxes: 10, credits: 4_000, storage: "10 GB", price: { month: "$29", year: null } },
      ],
      addon: { unit: "+10 GB", most: 4, price: "$5" },
      current: { plan: "plus", interval: "month", addonUnits: 0 },
    },
  },
} as const satisfies Record<string, PlansRead>;

/** A trial of Plus that ends on a day, two mailboxes allowed of five, and what is stored. */
export const TRIAL: SubscriptionStatus = {
  standing: { state: "trial", ends: "Nov 18, 2026" },
  mailboxes: 5,
  storage: "235 MB of 5 GB",
};

export interface FakeSubscriptionDoor extends SubscriptionDoor {
  /** How many times the plans were asked. */
  readonly reads: () => number;
  /** What each press handed the door, in order. */
  readonly picks: () => readonly (PlanPick | undefined)[];
  /** A new access answer arrives: the standing it carries. */
  show(next: SubscriptionStatus | null): void;
}

function next<T>(answers: (T | Promise<T> | typeof THROWS)[], none: T): Promise<T> {
  const answer = answers.shift() ?? none;
  return answer === THROWS ? Promise.reject(new Error("the door threw")) : Promise.resolve(answer);
}

/**
 * The account's subscription the test stands in for. It refuses unless handed an answer: a read with no answer left
 * could not read the prices, a press with no answer left could not open the page. `plans: NONE` is a host with no
 * read of the plans. It counts what reached it.
 */
export function fakeSubscriptionDoor(
  input: {
    readonly status?: SubscriptionStatus | null;
    readonly plans?: readonly (PlansRead | Promise<PlansRead> | typeof THROWS)[] | None;
    readonly manages?: readonly (ManageOutcome | Promise<ManageOutcome> | typeof THROWS)[];
  } = {},
): FakeSubscriptionDoor {
  let status = input.status === undefined ? TRIAL : input.status;
  const listeners = new Set<() => void>();
  const reads = input.plans === NONE ? null : [...(input.plans ?? [])];
  const manages = [...(input.manages ?? [])];
  const picks: (PlanPick | undefined)[] = [];
  let read = 0;
  return {
    status: {
      read: () => status,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    plans:
      reads === null
        ? NONE
        : () => {
            read += 1;
            return next<PlansRead>(reads, { ok: false, word: "plans_unavailable" });
          },
    manage: (pick) => {
      picks.push(pick);
      return next<ManageOutcome>(manages, "failed");
    },
    reads: () => read,
    picks: () => picks,
    show: (nextStatus) => {
      status = nextStatus;
      for (const listener of [...listeners]) listener();
    },
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
