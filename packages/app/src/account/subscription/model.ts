/**
 * Settings › Subscription, as data: where the account stands with the service, the plans and what each costs where
 * the server says so, and the one way to the account page. The pane draws a {@link SubscriptionModel} and reaches
 * nothing; its hook reaches the server through a {@link SubscriptionDoor}.
 *
 * Only the server answers a plan or a price, for the session's own account. Nothing here holds a figure: an amount
 * arrives as the reader says it, and one the server could not confirm is `null`, which is no figure: never zero,
 * never the other interval's, never a remembered one. Nothing is bought in the app: the verb opens the account page.
 * Its address is made by the press, never by the mount, and never leaves the door.
 */
import type { Answer, ManageOutcome, SubscriptionWord } from "../contract.js";
import type { None, Signal } from "../../host/index.js";
import type { AiCredits } from "../../settings/ai/budget.js";

export type PlanName = "solo" | "plus" | "pro";
export type PlanInterval = "month" | "year";

/** Where the account stands, as the service says it. A date arrives as the reader says it; `null` where none is known. */
export type Standing =
  | { readonly state: "trial"; readonly ends: string | null }
  | { readonly state: "trialEnded" }
  /** Access runs on for a while after a trial or a failed payment. */
  | { readonly state: "grace" | "overdue"; readonly until: string | null }
  | { readonly state: "active" }
  | { readonly state: "closed"; readonly why: "trialEnded" | "canceled" | "unpaid" | "suspended" | null };

/** What the access answer says of the subscription. */
export interface SubscriptionStatus {
  readonly standing: Standing;
  readonly trialEndedOn?: string;
  readonly trialProgress?: { readonly day: number; readonly total: number };
  /** How many mailboxes the account may connect; `null` where the answer does not say. */
  readonly mailboxes: number | null;
  /** The AI credits as the access answer reads them; said by the one reading every place shares (`CreditLines`). */
  readonly aiCredits?: AiCredits | null;
  /** What is stored of the limit, as the reader says it; `null` where the answer carries no storage block. */
  readonly storage: string | null;
}

/** One plan as a line: what it holds, and its price for each interval. A price is said, or it is no figure. */
export interface PlanLine {
  readonly plan: PlanName;
  readonly mailboxes: number;
  readonly credits?: number;
  readonly setupSuggestions?: number;
  /** Its room, as the reader says it. */
  readonly storage: string;
  readonly price: Readonly<Record<PlanInterval, string | null>>;
}

/** One unit of extra storage, as its own line. */
export interface AddonLine {
  readonly unit: string;
  readonly most: number;
  readonly price: string | null;
}

/** What the plans' read answers, when it answers. */
export type PlansAnswer =
  /** This server runs no billing program: nothing is for sale here. */
  | { readonly kind: "notForSale" }
  /** It runs one, and the program did not answer this read: no plans are drawn, and nothing false is said. */
  | { readonly kind: "unanswered" }
  | {
      readonly kind: "plans";
      readonly plans: readonly PlanLine[];
      readonly addon: AddonLine | null;
      /** What the account is on; `null` with no subscription. */
      readonly current: {
        readonly plan: PlanName;
        readonly interval: PlanInterval;
        readonly addonUnits: number;
      } | null;
    };

/** A plan and an interval the account page may open on: each from its closed set, each optional. */
export interface PlanPick {
  readonly plan?: PlanName;
  readonly interval?: PlanInterval;
}

/** How a host reaches the account's subscription. */
export interface SubscriptionDoor {
  /** The account's standing, from the access answer the shell already holds; `null` before the first answer. */
  readonly status: Signal<SubscriptionStatus | null>;
  /** The plans and their prices, asked once per visit; `none` where this host has no such read. */
  readonly plans: (() => Promise<Answer<PlansAnswer, SubscriptionWord>>) | None;
  /**
   * The press: makes the account page's address and leaves for it, in this tab, with no referrer. `nowhere`: no
   * page is served here, and the pane is withdrawn. `failed`: the address could not be made.
   */
  manage(pick?: PlanPick): Promise<ManageOutcome>;
}

/** What the pane draws. */
export interface SubscriptionModel {
  readonly status: SubscriptionStatus | null;
  /** The plans' sheet: no read on this host, asked, or what the read answered. `unavailable` keeps its Try again. */
  readonly plans:
    | { readonly at: "none" | "loading" | "unavailable" }
    | { readonly at: "read"; readonly answer: PlansAnswer; readonly interval: PlanInterval };
  /** The address is being made: the verb is off. */
  readonly opening: boolean;
  /** The last press could not open the page. */
  readonly failed: boolean;
  /** Month or year, for the prices shown. */
  choose(interval: PlanInterval): void;
  manage(pick?: PlanPick): void;
  /** Asks the plans again after a read that failed. */
  retryPlans(): void;
}

/*
 * THE TRANSITIONS. Two things move on this pane:
 *
 * - the plans' read: asked once as the pane opens where the host has one, again only by Try again; its answer is
 *   drawn as it came, and a read that failed keeps the verbs and offers Try again;
 * - the press: the address is made by the press and never by the mount, one at a time, the verb off while it is
 *   made; a press that could not open the page says so, and the next press takes that back.
 */

/** What the pane holds between two events: everything it draws but the standing, which the door holds. */
export type SubscriptionState = Pick<SubscriptionModel, "plans" | "opening" | "failed"> & {
  readonly chosenInterval?: PlanInterval;
};

export type SubscriptionEvent =
  /** The plans are asked: as the pane opens, or by Try again. */
  | { readonly kind: "plansAsked" }
  | { readonly kind: "plansAnswered"; readonly answer: Answer<PlansAnswer, SubscriptionWord> }
  /** Month or year chosen for the prices shown. */
  | { readonly kind: "chosen"; readonly interval: PlanInterval }
  /** The press that makes the account page's address. */
  | { readonly kind: "pressed" }
  | { readonly kind: "managed"; readonly outcome: ManageOutcome };

/** The pane as it opens: the plans asked where this host has their read, none where it has not. */
export function subscriptionStart(readsPlans: boolean): SubscriptionState {
  return { plans: { at: readsPlans ? "loading" : "none" }, opening: false, failed: false };
}

/** Start on the account's interval when it has a price, or the interval the catalogue offers. */
function firstInterval(answer: PlansAnswer): PlanInterval {
  if (answer.kind !== "plans") return "month";
  const preferred = answer.current?.interval ?? "month";
  const other = preferred === "month" ? "year" : "month";
  return !answer.plans.some((line) => line.price[preferred] !== null) &&
    answer.plans.some((line) => line.price[other] !== null)
    ? other
    : preferred;
}

/** One event, applied. A press while the address is being made is not taken. */
export function subscriptionStep(state: SubscriptionState, event: SubscriptionEvent): SubscriptionState {
  switch (event.kind) {
    case "plansAsked":
      return { ...state, plans: { at: "loading" } };
    case "plansAnswered": {
      if (state.plans.at !== "loading") return state;
      const { answer } = event;
      // Whatever kept the read from answering, the prices could not be read: no figure, and Try again.
      if (!answer.ok) return { ...state, plans: { at: "unavailable" } };
      const interval = state.chosenInterval;
      const canKeep =
        answer.value.kind === "plans" &&
        interval !== undefined &&
        answer.value.plans.some((line) => line.price[interval] !== null);
      return {
        ...state,
        plans: {
          at: "read",
          answer: answer.value,
          interval: canKeep ? interval : firstInterval(answer.value),
        },
      };
    }
    case "chosen":
      return state.plans.at === "read"
        ? { ...state, chosenInterval: event.interval, plans: { ...state.plans, interval: event.interval } }
        : state;
    case "pressed":
      return state.opening ? state : { ...state, opening: true, failed: false };
    case "managed":
      return { ...state, opening: false, failed: event.outcome === "failed" };
  }
}

/** The model a state draws, over the standing the door holds now and the verbs the hook hands in. */
export function subscriptionModelOf(
  state: SubscriptionState,
  status: SubscriptionStatus | null,
  verbs: Pick<SubscriptionModel, "choose" | "manage" | "retryPlans">,
): SubscriptionModel {
  return { status, ...state, ...verbs };
}
