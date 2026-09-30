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
/** Which navigation destinations never fold off the rail: More, where every folded one is reached. */
export function railDestinationFixed(id: string): boolean {
  return id === "more";
}

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

/* ── the dock ────────────────────────────────────────────────────────────────────────────── */

/** The dock's metrics: 44pt buttons, 2 inside a pill, 8 pill padding, 8 between the two pills, 12 each side. */
export const DOCK = { btn: 44, itemGap: 2, groupPad: 8, groupGap: 8, sideInset: 12 } as const;
/** The fixed verbs pill — New mail and Search, two buttons that never fold. */
const DOCK_VERBS = 2 * DOCK.btn + DOCK.itemGap + DOCK.groupPad;

/** The width the dock needs with `k` destinations standing. */
export const dockNeed = (k: number): number =>
  2 * DOCK.sideInset + (k * DOCK.btn + Math.max(0, k - 1) * DOCK.itemGap + DOCK.groupPad) + DOCK.groupGap + DOCK_VERBS;

/**
 * The order destinations leave the dock and the rail for More — the rail's own bottom-to-top, the
 * dock's right-to-left. More, New mail, Search and Back never fold.
 */
export const DESTINATION_FOLD_ORDER = ["receipts", "reads", "screener", "index"] as const;

/**
 * THE DOCK FOLDS; NOTHING CLIPS. While the row needs more than `room`, the next destination in
 * {@link DESTINATION_FOLD_ORDER} leaves it into More. `ids` is the row as ordered; `null` room (no
 * measurement yet) keeps the whole row.
 */
export function dockFold(ids: readonly string[], room: number | null): { kept: string[]; folded: string[] } {
  const kept = [...ids];
  const folded: string[] = [];
  if (room === null) return { kept, folded };
  for (const id of DESTINATION_FOLD_ORDER) {
    if (dockNeed(kept.length) <= room) break;
    const at = kept.indexOf(id);
    if (at < 0) continue;
    kept.splice(at, 1);
    folded.push(id);
  }
  return { kept, folded };
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

/* ── the bar's inputs, composed the way GlassActionBar renders them ──────────────────────── */

/** The pill's horizontal chrome the row pays once: 1 border + 6 content padding, each side. */
export const BAR_PILL_CHROME = 2 * (1 + 6);
/** The row gap between capsules — `GlassActionBar`'s contentStyle gap. */
export const BAR_GAP = 4;
/** A rendered segment track (two or more members) adds `padding: 2` each side of its run. */
export const SEG_TRACK_PAD = 2 * 2;

export interface BarVerbLite {
  id: string;
  seg?: string | null;
}

/**
 * The room follows EVERY layout reading — never first-write-wins, so a posture flip or a
 * rotation re-admits against the new pane. A zero-width reading is a layout in flight, not a
 * room: the previous reading stands, so a transient 0 cannot fold a standing bar.
 */
export function nextRoom(prev: number | null, width: number): number | null {
  return width > 0 ? width : prev;
}

/**
 * The bar's whole admission, pure — the webapp `bar-density.ts` walk over RN's measurements.
 * `widths` is the hidden copy's record (verb ids plus `__reply`, `__read`, `__more`); null
 * before the first measurement, where the floor stands (the desktop's absent `data-admit`).
 * The floor: Reply and the read switch each pay a row gap; More and the pill chrome pay none.
 * The member that makes a segment run two long pays the track's padding — the track renders
 * exactly then, and an uncharged track is the 4dp of overflow the law forbids.
 */
export function barAdmitted(args: {
  verbs: readonly BarVerbLite[];
  widths: Readonly<Record<string, number>> | null;
  reply: boolean;
  readSwitch: boolean;
  room: number | null;
  gap?: number;
  /** Verbs of the FLOOR (Forward): they stand at every width, so they pay as fixed cost and are not admitted. */
  floor?: readonly string[];
}): number {
  const { widths, reply, readSwitch, room } = args;
  const floor = args.floor ?? [];
  const verbs = args.verbs.filter((v) => !floor.includes(v.id));
  const gap = args.gap ?? BAR_GAP;
  if (room === null || widths === null) return 0;
  const boxes: BarVerbBox[] = verbs.map((v, i) => {
    const seg = v.seg ?? null;
    const secondOfRun =
      seg !== null &&
      i > 0 &&
      (verbs[i - 1].seg ?? null) === seg &&
      (i === 1 || (verbs[i - 2].seg ?? null) !== seg);
    return { id: v.id, width: (widths[v.id] ?? 0) + (secondOfRun ? SEG_TRACK_PAD : 0), seg };
  });
  const fixed =
    (reply ? (widths["__reply"] ?? 0) + gap : 0) +
    floor.reduce((n, id) => n + (widths[id] ?? 0) + gap, 0) +
    (readSwitch ? (widths["__read"] ?? 0) + gap : 0) +
    (widths["__more"] ?? 0) +
    BAR_PILL_CHROME;
  return admitVerbs(boxes, room, fixed, gap);
}

/** An icon face's box: the 44pt touch square. */
export const ICON_FACE = 44;

/**
 * THE FLOOR'S FACES. The floor — Reply, Forward, the read switch, ⋯ — stands at every width; when
 * its worded form exceeds the room the read switch takes its icon face, and if the floor still
 * exceeds it Forward takes its own. Answers the widths to admit with (the icon boxes substituted)
 * and which faces are icons. Before a measurement nothing is an icon.
 */
export function barFloorFaces(args: {
  widths: Readonly<Record<string, number>> | null;
  room: number | null;
  reply: boolean;
  readSwitch: boolean;
  floor: readonly string[];
  gap?: number;
}): { widths: Readonly<Record<string, number>> | null; readIcon: boolean; floorIcon: boolean } {
  const { widths, room, reply, readSwitch, floor } = args;
  const gap = args.gap ?? BAR_GAP;
  if (widths === null || room === null) return { widths, readIcon: false, floorIcon: false };
  const need = (w: Readonly<Record<string, number>>) =>
    (reply ? (w["__reply"] ?? 0) + gap : 0) + floor.reduce((n, id) => n + (w[id] ?? 0) + gap, 0)
    + (readSwitch ? (w["__read"] ?? 0) + gap : 0) + (w["__more"] ?? 0) + BAR_PILL_CHROME;
  if (need(widths) <= room) return { widths, readIcon: false, floorIcon: false };
  const readIconWidths = readSwitch ? { ...widths, __read: ICON_FACE } : widths;
  if (need(readIconWidths) <= room || floor.length === 0) return { widths: readIconWidths, readIcon: readSwitch, floorIcon: false };
  const both = { ...readIconWidths, ...Object.fromEntries(floor.map((id) => [id, ICON_FACE])) };
  return { widths: both, readIcon: readSwitch, floorIcon: true };
}
