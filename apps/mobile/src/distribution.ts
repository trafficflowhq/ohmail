/**
 * WHICH WAY THIS COPY WAS DISTRIBUTED, decided at BUILD time and never guessed at runtime.
 *
 * The desktop's twin with its default INVERTED, which is the point: every phone build this project
 * ships goes to a store, so a build that does not know what it is IS a store copy. A store copy may
 * not open a page where a subscription is bought (App Review 3.1.1, Play's billing rule), and a
 * runtime sniff answers differently under a test, a sideload and a simulator.
 *
 * `sideload` is set deliberately, and moves one surface: whether the wall offers that button.
 */

/** Every distribution this app knows. `store` is the default and what an unstamped build is. */
export const DISTRIBUTIONS = ["store", "sideload"] as const;

export type Distribution = (typeof DISTRIBUTIONS)[number];

/** The environment name Expo's bundler inlines. `EXPO_PUBLIC_*` is a literal at bundle time. */
export const DISTRIBUTION_ENV = "EXPO_PUBLIC_OHMAIL_DISTRIBUTION";

/**
 * Read the flag, defaulting to the withholding face.
 *
 * A word this file does not know reads as `store`, which is the opposite direction from the
 * desktop's fallback and for the same reason: there the unknown must not WITHHOLD, here it must
 * not OFFER. A typo may cost a developer their Subscribe button; it may not cost a store review.
 */
export function distributionOf(raw: unknown): Distribution {
  return raw === "sideload" ? "sideload" : "store";
}

/**
 * The literal Expo folds in from `EXPO_PUBLIC_OHMAIL_DISTRIBUTION` — read the way
 * `EXPO_PUBLIC_COMMIT` and `EXPO_PUBLIC_OHMAIL_POSTURE` are read on this app, as a whole
 * `process.env.X` member expression so the bundler can substitute it.
 */
export const DISTRIBUTION: Distribution = distributionOf(
  process.env.EXPO_PUBLIC_OHMAIL_DISTRIBUTION,
);

/**
 * May this copy send somebody to the operator's account page? False on a store build.
 *
 * The page the button opens is where a subscription is bought, so the button is what the store
 * rules are about — not the wall, not the export, and not deleting an account. A store build keeps
 * every one of those and loses this one control, replaced by the sentence naming where to go.
 */
export function linksOutToBilling(distribution: Distribution = DISTRIBUTION): boolean {
  return distribution === "sideload";
}
