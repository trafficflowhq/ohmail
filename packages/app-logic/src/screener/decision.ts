/**
 * WHERE A DECISION SENDS A SENDER, and how wide it reaches. The component kit's decision bar
 * declares the same two unions for its buttons; behaviour does not import the kit, so they are
 * declared here too, and the compiler holds each pair equal where the shell hands one to the other.
 */
export type DecisionDestination = "ohbox" | "reads" | "receipts" | "screened" | "spam";
export type DecisionScope = "sender" | "domain";

/**
 * The destinations that demote a sender, and so offer no read verb: a product rule, declared here beside the kit's
 * own set for its bar, and held equal to it by `apps/webapp/test/app-logic-twins.test.ts`.
 */
export const DECISION_QUIET: ReadonlySet<DecisionDestination> = new Set<DecisionDestination>([
  "screened",
  "spam",
]);
