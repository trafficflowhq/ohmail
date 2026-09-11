/**
 * The pairing link grammar — moved to `@trafficflow/core/pair-link`,
 * re-exported here so existing imports stand. A third parser exists: the
 * desktop's client-door paste is parsed in `apps/sidecar`, a Node process
 * that may not link this package (its one-pipeline census refuses
 * `@ohmail/client-engine` in the mirror's graph — the barrel drags in
 * IndexedDB and the optimistic overlay). So the grammar lives on a
 * dependency-free core subpath, like `./drain-policy`; copying it is how
 * two parsers drift. A symbol that needs a change is changed in core.
 */
export {
  PAIR_PIN_VERSION,
  isPairPin,
  originNeedsPin,
  pairLink,
  parsePairLink,
  shortPin,
  type PairLink,
} from "@trafficflow/core/pair-link";
