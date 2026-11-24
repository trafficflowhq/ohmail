/**
 * Settings › Subscription. A shell's registration draws {@link SubscriptionPane} over `useSubscription` and a
 * {@link SubscriptionDoor} it fills. The shared trial progress row can also be used on its own.
 */
export { SubscriptionPane, type SubscriptionPaneProps } from "./SubscriptionPane.js";
export { TrialProgress } from "./TrialProgress.js";
export { readPlansOf, type ReadPlans } from "./SubscriptionPlans.js";
export {
  subscriptionModelOf,
  subscriptionStart,
  subscriptionStep,
  type AddonLine,
  type PlanInterval,
  type PlanLine,
  type PlanName,
  type PlanPick,
  type PlansAnswer,
  type Standing,
  type SubscriptionDoor,
  type SubscriptionEvent,
  type SubscriptionModel,
  type SubscriptionState,
  type SubscriptionStatus,
} from "./model.js";
export { useSubscription } from "./use-subscription.js";
export { subscriptionStates } from "./states.js";
export { SUBSCRIPTION_NAMESPACE } from "./namespace.js";
