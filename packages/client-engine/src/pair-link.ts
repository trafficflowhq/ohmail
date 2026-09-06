/**
 * THE PAIRING LINK — moved to `@trafficflow/core/pair-link`, re-exported here so nothing that
 * already imports it has to move.
 *
 * ── WHY IT MOVED, WHICH IS THE ONLY THING THIS FILE HAS TO SAY ──────────────────────────────
 *
 * There is a THIRD parser now. The desktop's client door pastes a link printed by ANOTHER
 * machine's desktop, and that parse happens in `apps/sidecar` — a Node process that may not link
 * this package: the sidecar's own one-pipeline census asserts `@ohmail/client-engine` appears
 * in no import in the mirror's graph, because the barrel reaches IndexedDB, the search index and
 * the whole optimistic-overlay machinery, and a Node mirror driver that pulled it in would be
 * carrying a second client.
 *
 * So the grammar lives in the one package all three graphs already compile, on a dependency-free
 * source subpath — `./drain-policy`'s reasoning, for the same reason and with the same shape.
 * COPYING it was the alternative and it is the failure this repository has already paid for once:
 * two copies that agree the day they are written, and a later change to the fragment's form that
 * lands on the composer and misses one parser. One definition means one mutation reddens every
 * guard over it.
 *
 * This file stays because `index.ts` re-exports from `./pair-link.js` and because the phone
 * reaches every one of these symbols through this package's barrel. It adds nothing and decides
 * nothing; a symbol that needs a change is changed in core.
 */
export {
  PAIR_PIN_VERSION,
  isPairPin,
  originNeedsPin,
  pairLink,
  parsePairLink,
  type PairLink,
} from "@trafficflow/core/pair-link";
