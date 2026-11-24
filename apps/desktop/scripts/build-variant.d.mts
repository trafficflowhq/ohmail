/** Every distribution, in the order the usage line prints them. */
export const DISTRIBUTIONS: readonly string[];

/** The three halves one `--distribution` word selects on one platform; throws a sentence when refused. */
export function buildVariant(asked: { distribution: string; platform: string }): {
  literal: string;
  features: string;
  configs: string[];
};
