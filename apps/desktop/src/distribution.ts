/**
 * WHICH WAY THIS COPY WAS DISTRIBUTED, decided at BUILD time and never guessed at runtime.
 *
 * The direct download (`direct`) and the Mac App Store (`mas`) are two builds of one app, and two
 * surfaces differ between them: a store copy is updated by the store, and a store copy may not send
 * anybody to a page where a subscription is bought (App Review 3.1.1). Both are properties of the
 * ARTIFACT, so both are read from a literal the bundler folded in — a runtime sniff (a path, a
 * receipt, a bundle id) answers differently under a test, a symlink and a copied app, and the one
 * thing neither surface may do is appear on a store build because a probe returned the wrong thing.
 */

/** Every distribution this window knows. `direct` is the default and what every other build is. */
export const DISTRIBUTIONS = ["direct", "mas"] as const;

export type Distribution = (typeof DISTRIBUTIONS)[number];

/**
 * The literal `vite.config.ts` folds in from `OHMAIL_DISTRIBUTION`, or `direct` where no bundler
 * ran (the test runner importing source) or where nothing set it. A value this file does not know
 * reads as `direct`, because the surfaces below are WITHHELD by `mas` and a typo must not withhold
 * them silently — an unknown word leaves the ordinary app, and `mas-build.sh` asserts the literal
 * it asked for reached the bundle rather than trusting this fallback.
 */
export const DISTRIBUTION: Distribution = ((): Distribution => {
  const raw = typeof __OHMAIL_DISTRIBUTION__ === "string" ? __OHMAIL_DISTRIBUTION__ : "direct";
  return (DISTRIBUTIONS as readonly string[]).includes(raw) ? (raw as Distribution) : "direct";
})();

/** Does this copy replace its own files? False on the store build: the store does that. */
export function selfUpdates(distribution: Distribution = DISTRIBUTION): boolean {
  return distribution !== "mas";
}

/** May this copy send somebody to the operator's subscription page? False on the store build. */
export function linksOutToBilling(distribution: Distribution = DISTRIBUTION): boolean {
  return distribution !== "mas";
}
