/**
 * The two fold laws of the glass primitives, as arithmetic — no renderer needed to prove them.
 * RAIL: a vertical column is BUDGETED against its height; what does not fit folds bottom-to-top
 * into ⋯/More (Apple: toolbar items "overflow from bottom to top"), so nothing ever clips —
 * measured failing in the design prototype on the closed display in landscape. Items marked
 * `fixed` (Back, the Reply group, More itself) never fold.
 * BAR: the ActionBar admits verbs greedily IN ROW ORDER while they fit — a later verb never
 * stands while an earlier one is folded — and a segment's members abut, paying the row gap
 * once. The webapp's `bar-density.ts` law; the measurement is RN's, the admission is here.
 */

/* ── the rail ────────────────────────────────────────────────────────────────────────────── */

/** The prototype's egroup metrics: 44pt buttons, 2 gap inside a pill, 8 pill padding, 10 between pills. */
export const RAIL = { btn: 44, itemGap: 2, groupPad: 8, groupGap: 10 } as const;

export interface RailEntry {
  id: string;
  /** Never folds: Back, the compose accent, More itself, search. */
  fixed?: boolean;
}

/** One pill of n items, measured. */
export const railGroupHeight = (n: number): number =>
  n <= 0 ? 0 : n * RAIL.btn + (n - 1) * RAIL.itemGap + RAIL.groupPad;

export const railColumnHeight = (groups: readonly (readonly RailEntry[])[]): number => {
  const live = groups.filter((g) => g.length > 0);
  return live.reduce((a, g) => a + railGroupHeight(g.length), 0) + Math.max(0, live.length - 1) * RAIL.groupGap;
};

export interface RailFold {
  /** The groups as rendered, folded items removed, empty groups dropped. */
  kept: RailEntry[][];
  /** What went behind More, in fold order (last-listed first — bottom-to-top). */
  folded: RailEntry[];
}

/**
 * Fold the column into `availableHeight`: repeatedly remove the LAST non-fixed item of the
 * LAST group that still has one, until the column fits or nothing foldable remains. A caller
 * that shows the folded set behind ⋯ must include a fixed More entry in its groups — folding
 * cannot create the room More itself would need.
 */
export function railFold(groups: readonly (readonly RailEntry[])[], availableHeight: number): RailFold {
  const kept: RailEntry[][] = groups.map((g) => [...g]);
  const folded: RailEntry[] = [];
  const fits = () => railColumnHeight(kept) <= availableHeight;
  while (!fits()) {
    let took = false;
    for (let gi = kept.length - 1; gi >= 0 && !took; gi--) {
      const g = kept[gi];
      for (let i = g.length - 1; i >= 0; i--) {
        if (g[i].fixed !== true) {
          folded.push(g[i]);
          g.splice(i, 1);
          took = true;
          break;
        }
      }
    }
    if (!took) break; // only fixed items remain — the floor; never fold Back or More
  }
  return { kept: kept.filter((g) => g.length > 0), folded };
}

/* ── the bar ─────────────────────────────────────────────────────────────────────────────── */

export interface BarVerbBox {
  id: string;
  /** Measured width, dp — from the hidden copy's onLayout. */
  width: number;
  /** The segmented control this verb continues, or null for one that stands alone. */
  seg: string | null;
}

/**
 * How many verbs stand, greedy prefix over row order. Fixed cost first (Reply, the read
 * switch, More — whatever the caller always keeps); each admitted verb pays its width plus a
 * gap, except one continuing its predecessor's segment, which abuts.
 */
export function admitVerbs(
  verbs: readonly BarVerbBox[],
  room: number,
  fixedWidth: number,
  gap: number,
): number {
  let used = fixedWidth;
  let admitted = 0;
  for (let i = 0; i < verbs.length; i++) {
    const continues = verbs[i].seg !== null && i > 0 && verbs[i - 1].seg === verbs[i].seg && admitted === i;
    const need = verbs[i].width + (continues ? 0 : gap);
    if (used + need > room) break;
    used += need;
    admitted++;
  }
  return admitted;
}
