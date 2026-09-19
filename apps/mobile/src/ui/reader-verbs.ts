/**
 * Which reader verbs stand where, per posture: every verb stays available, visible and
 * functional on every device × posture, as arithmetic the census walks
 * (`test/reader-verbs-census.test.ts` refuses a missing verb by name). Three presentations,
 * decided by `scaffoldPlan`: the compact bottom bar; the desktop ActionBar pinned at the
 * reading pane's foot (`plan.actionBar`); the right-edge rail on the unfolded-landscape Duo
 * (`plan.railCarriesReaderVerbs`): back · reply · reply all · forward, Done · Park · Junk, ⋯.
 * Junk has no row verb on the ActionBar — the desktop's own design; it stays behind Move —
 * and the rail is the one surface carrying it directly. Pure and dependency-free on purpose.
 */
import type { ScaffoldPlan } from "./scaffold/plan";

/** The webapp reading pane's verb set — parity is derived in `test/action-parity.test.ts`. */
export type ReaderVerbId =
  | "reply"
  | "replyAll"
  | "forward"
  | "later"
  | "aside"
  | "resurface"
  | "tag"
  | "screening"
  | "move"
  /** The one three-faced read slot: Done / Mark as read / Mark unread — never empty, never two. */
  | "read"
  | "delete";

/** The rail's own entries beyond the verb set: back closes the reader, ⋯ opens the rest. */
export type RailEntryId = ReaderVerbId | "back" | "junk" | "more";

export interface ReaderVerbFacts {
  /** The webapp's absence rule: Reply all only where an envelope was admitted. */
  canReplyAll: boolean;
  /** Forward never on `no_forward`. */
  noForward: boolean;
  /** The reader Delete verb ships behind "Use folders" (FOLDERS-SPEC.md §16.3/§16.7). */
  foldersEnabled: boolean;
  /** Junk = the move panel's spam target — absent where the message already presents there. */
  junkOffered: boolean;
}

export type ReaderVerbMode = "compact" | "bar" | "rail";

/** Which presentation a posture takes — the plan already encodes the placement rules. */
export function readerVerbMode(
  plan: Pick<ScaffoldPlan, "actionBar" | "railCarriesReaderVerbs">,
): ReaderVerbMode {
  if (plan.railCarriesReaderVerbs) return "rail";
  if (plan.actionBar) return "bar";
  return "compact";
}

const admits = (f: ReaderVerbFacts, id: ReaderVerbId): boolean =>
  id === "replyAll" ? f.canReplyAll : id === "forward" ? !f.noForward : id === "delete" ? f.foldersEnabled : true;

const admit = (f: ReaderVerbFacts, ids: readonly ReaderVerbId[]): ReaderVerbId[] =>
  ids.filter((id) => admits(f, id));

export interface ReaderVerbPlacement {
  /** On the always-visible surface. The bar may runtime-fold a tail of these into ⋯ — in the
   *  row or behind More, never both, never gone (`glass/fold.ts#admitVerbs`). */
  standing: ReaderVerbId[];
  /** One press away, behind ⋯. */
  behindMore: ReaderVerbId[];
}

/**
 * The bar's row order is the webapp's `BAR_VERB_ORDER` with Reply in front and the read
 * switch behind — row order is fold order there, so the order here IS the desktop's.
 */
const BAR_STANDING: readonly ReaderVerbId[] = [
  "reply", "replyAll", "forward", "later", "aside", "resurface", "tag", "screening", "move", "read",
];

/** The compact More sheet's rows, the shipped order — read parted from delete by rules. */
const COMPACT_MORE: readonly ReaderVerbId[] = [
  "replyAll", "forward", "tag", "screening", "move", "read", "delete",
];

const RAIL_MORE: readonly ReaderVerbId[] = ["later", "resurface", "tag", "screening", "move", "delete"];

export function readerVerbPlacement(mode: ReaderVerbMode, f: ReaderVerbFacts): ReaderVerbPlacement {
  if (mode === "bar") {
    return { standing: admit(f, BAR_STANDING), behindMore: admit(f, ["delete"]) };
  }
  if (mode === "rail") {
    const standing = railReaderGroups(f)
      .flat()
      .filter((id): id is ReaderVerbId => id !== "back" && id !== "junk" && id !== "more");
    return { standing, behindMore: admit(f, RAIL_MORE) };
  }
  return { standing: ["reply", "later", "aside", "resurface"], behindMore: admit(f, COMPACT_MORE) };
}

/**
 * The rail's groups, top-aligned, the prototype's exact order: [back] [reply · reply all ·
 * forward] [Done · Park · Junk] [⋯]. Eight 44pt entries in four pills fit the Duo's inner
 * height with room to spare; anything more folds by `railFold`'s budget, which is why the
 * rest of the verb set lives behind ⋯ rather than on the column.
 */
export function railReaderGroups(f: ReaderVerbFacts): RailEntryId[][] {
  const answer: RailEntryId[] = ["read", "aside"];
  if (f.junkOffered) answer.push("junk");
  return [["back"], admit(f, ["reply", "replyAll", "forward"]), answer, ["more"]];
}

/**
 * HOW EACH VERB IS TAKEN BACK — the undo arm the census refuses a verb without. "inverse":
 * Undo dispatches the engine's own reversal (`inverseMutations`, read pre-press in
 * `state/live.ts`). "window": a delayed commit — delete opens `state/held-delete.ts` and Undo
 * cancels a mutation not yet sent, the only undo that wire can honour. "composer": the press
 * opens a draft, which has its own doors. "routing-bounded": Move (and Junk, which rides it)
 * inverts as a plain move and offers nothing where it rewrote the sender's rules — no wire
 * inverse; the live arm states it. "routing-none": Screening always rewrites rules. The census
 * cross-checks the mutation-backed arms against the engine's `UNDO_CLASS` — no drift possible.
 */
export type VerbUndoArm = "inverse" | "window" | "composer" | "routing-bounded" | "routing-none";

export const VERB_UNDO_ARM: Record<ReaderVerbId, VerbUndoArm> = {
  reply: "composer",
  replyAll: "composer",
  forward: "composer",
  later: "inverse",
  aside: "inverse",
  resurface: "inverse",
  tag: "inverse",
  screening: "routing-none",
  move: "routing-bounded",
  read: "inverse",
  delete: "window",
};

/** Every verb a message admits, mode-independent — what the census demands reachable. */
export function admissibleVerbs(f: ReaderVerbFacts): ReaderVerbId[] {
  return admit(f, [
    "reply", "replyAll", "forward", "later", "aside", "resurface", "tag", "screening", "move", "read", "delete",
  ]);
}
