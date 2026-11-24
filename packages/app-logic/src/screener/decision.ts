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

/** The five decisions in the order every surface lists them: the Ohbox, the two automated piles, the demotions. */
export const DECISION_ORDER: readonly DecisionDestination[] = [
  "ohbox",
  "reads",
  "receipts",
  "screened",
  "spam",
];

/** Each decision's key; Shift on the first three also marks the sender's letters read. Twin of the kit's table. */
export const DECISION_KEY: Readonly<Record<DecisionDestination, string>> = {
  ohbox: "o",
  reads: "r",
  receipts: "c",
  screened: "n",
  spam: "x",
};

/** The pile's name as a PLACE (titles, reports, hints), a key of the `screener` namespace. */
export const PILE_KEY: Readonly<Record<DecisionDestination, string>> = {
  ohbox: "pileOhbox",
  reads: "pileReads",
  receipts: "pileReceipts",
  screened: "pileScreened",
  spam: "pileSpam",
};

/** The pile's name as the ACT on a decision's button ("Screen out", never "Screened out"). */
export const PILE_VERB_KEY: Readonly<Record<DecisionDestination, string>> = {
  ...PILE_KEY,
  screened: "pileScreenOut",
};
