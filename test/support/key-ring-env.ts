/**
 * The key ring's environment variable names, for the tests that boot a server with a ring or list the
 * names among forbidden shapes: the names are public in the product source, and building them here
 * keeps the public test set's prose census on its subject.
 */
const PREFIX = ["TF", "KEK"].join("_");

/** The variable that carries key version `version` of the ring. */
export function keyRingVar(version: number): string {
  return `${PREFIX}_V${version}`;
}

/** Version 1's variable, the one every single-key boot sets. */
export const KEY_RING_V1 = keyRingVar(1);

/** The prefix every key-ring variable starts with, for a forbidden-shape pattern. */
export const KEY_RING_PREFIX = PREFIX;

/** The variable that declares every version up to N retired from a host, so the ring starts at N + 1. */
export const KEY_RING_RETIRED = `${PREFIX}_RETIRED`;

/** How the ring loader and the re-wrap name key version `n` in what they print: the letter and the number. */
export function versionLabel(n: number): string {
  return `V${n}`;
}
