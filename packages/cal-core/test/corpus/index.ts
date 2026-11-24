/** Every calendar text of the corpus, for the proofs that hold of all of them (the round trip, the twin reader). */
import { BENCH } from "./bench.js";
import { NASTY } from "./nasty.js";
import { PROVIDERS } from "./providers.js";
import type { Fixture } from "./types.js";

export const CORPUS: readonly Fixture[] = [...BENCH, ...PROVIDERS, ...NASTY];
export type { Fixture };
