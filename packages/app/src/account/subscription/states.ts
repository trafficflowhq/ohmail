import type { AccountState } from "../contract.js";
import type { PlansAnswer, Standing, SubscriptionModel, SubscriptionStatus } from "./model.js";

const still = (): void => {};

/** A Plus account's mailboxes and what is stored, the standing changed per state. Days are as a reader says them. */
const statusOf = (standing: Standing): SubscriptionStatus => ({
  standing,
  mailboxes: 5,
  storage: "235 MB of 5 GB",
});

const at = (address: string | null, over: Partial<SubscriptionModel>) =>
  ({
    address,
    model: {
      status: null,
      plans: { at: "none" },
      opening: false,
      failed: false,
      choose: still,
      manage: still,
      retryPlans: still,
      ...over,
    },
  }) as const satisfies AccountState<SubscriptionModel>;

/**
 * The pane's states, each with its address in the comparison's registry, or `null` where no picture draws it. No
 * amount is written into the app: the plans and their prices are the read the states page hands in (the pictures'
 * card), and without it every state draws what today's web draws, the standing and the press, with no plans and no
 * figure. Credit figures are supplied when the access read names a balance. The registry’s `door=cloud&…&state=managelink`
 * is the desktop's own step of showing the made address as a link, which this pane does not have.
 */
export function subscriptionStates(read: PlansAnswer | null = null) {
  const plans: SubscriptionModel["plans"] =
    read === null ? { at: "none" } : { at: "read", answer: read, interval: "month" };
  const trial = statusOf({ state: "trial", ends: "Nov 18, 2026" });
  const noPlan: SubscriptionModel["plans"] =
    read !== null && read.kind === "plans"
      ? { at: "read", answer: { ...read, current: null }, interval: "month" }
      : plans;
  return {
    trial: at("screen=settings&sec=subscription", { status: trial, plans }),
    info: at("screen=settings&sec=subscription&state=info", { status: trial, plans }),
    overdue: at("screen=settings&sec=subscription&state=overdue", {
      status: statusOf({ state: "overdue", until: "Nov 24, 2026" }),
      plans,
    }),
    active: at("screen=settings&sec=subscription&state=active", {
      status: statusOf({ state: "active" }),
      plans,
    }),
    manageFailed: at("screen=settings&sec=subscription&state=managefailed", {
      status: trial,
      plans,
      failed: true,
    }),
    canceled: at("screen=settings&sec=subscription&state=canceled", {
      status: statusOf({ state: "closed", why: "canceled" }),
      plans,
    }),
    incomplete: at("screen=settings&sec=subscription&state=incomplete", {
      status: statusOf({ state: "overdue", until: null }),
      plans,
    }),
    unpaid: at("screen=settings&sec=subscription&state=unpaid", {
      status: statusOf({ state: "closed", why: "unpaid" }),
      plans,
    }),
    trialEnded: at("screen=settings&sec=subscription&state=trialended", {
      status: statusOf({ state: "closed", why: "trialEnded" }),
      plans,
    }),
    noPlan: at("screen=settings&sec=subscription&state=noplan", { plans: noPlan }),
    // A window signed in to an account: the press alone, before the window has the standing to draw.
    window: at("door=cloud&screen=settings&sec=subscription", {}),
    windowOpening: at("door=cloud&screen=settings&sec=subscription&state=managing", { opening: true }),
    windowFailed: at("door=cloud&screen=settings&sec=subscription&state=managefailed", { failed: true }),
    grace: at(null, { status: statusOf({ state: "grace", until: "Nov 24, 2026" }), plans }),
    suspended: at(null, { status: statusOf({ state: "closed", why: "suspended" }), plans }),
    opening: at(null, { status: trial, plans, opening: true }),
    plansAsked: at(null, { status: trial, plans: { at: "loading" } }),
    plansUnavailable: at(null, { status: trial, plans: { at: "unavailable" } }),
    notForSale: at(null, {
      status: trial,
      plans: { at: "read", answer: { kind: "notForSale" }, interval: "month" },
    }),
    unanswered: at(null, {
      status: trial,
      plans: { at: "read", answer: { kind: "unanswered" }, interval: "month" },
    }),
  };
}
