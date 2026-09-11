"use client";

/**
 * The shape of the screen that is coming — and nothing whatsoever about what will be on it. Two waits are long enough
 * to owe a person something: a standalone first launch replaying a large write-ahead log (bounded by the log, once —
 * measured ~100 s on a directory grown to tens of gigabytes; the engine now checkpoints on a timer), and a cold
 * mirror in a browser tab (the first `/sync` page has not landed, so the list is not empty — it is unknown).
 */

/**
 * The geometry is the app's OWN (owner report, 2026-08-26): a generic wireframe is a promise in the wrong shape,
 * answered by a visible re-layout — so every measure is the live shell's by name: `.deck`'s 224px rail plus
 * `.view.split`'s `--split` with the same 16px gaps, the rail's insides per `rail.css`, the list as
 * `.list-col`/`.vhead`/`.row` verbatim, the reading pane the real unselected `ReadColumn`. The mobile port reached
 * this standard first; this brings the origin up to its port.
 */

/**
 * This was ruled out once, on the measurement that now argues for it: an ordinary launch answers in
 * under a second, so a skeleton would strobe every healthy boot. Right about the ordinary launch,
 * wrong to stop there — so this is a function of TIME, exactly as `loading-grace.ts`: below the
 * grace nothing is drawn, above it the window carries the geometry it is about to fill. The grace
 * is 300 ms against the sentence's 600, deliberately: a sentence is a demand on attention, a shape
 * under one is not, so the cheaper thing may arrive earlier.
 */

/**
 * It must never carry content — this part is a RULE. A placeholder row, an invented count or a
 * skeleton shaped like mail is the worst failure this product has: something plausible rendered as
 * if it were the reader's own mail. A silhouette with zero text nodes cannot be mistaken for a
 * message; `aria-hidden` says the same to the other half of the audience. The widths are a fixed
 * table, not derived and not random: derived widths would be content — a bar as long as a real
 * subject line IS a claim about that subject — and random ones would differ between two paints.
 */

import { useLoadingGrace } from "./loading-grace";

/**
 * How long a wait may go unshaped. Three hundred milliseconds.
 *
 * Above the sub-second launch an established install has, so a healthy boot never sees it, and
 * far below the two waits this exists for. Exported so a test can drive fake timers to either
 * side of it rather than sleeping past a literal it cannot see — `loading-grace.ts`'s own reason
 * for exporting its constant.
 */
export const BOOT_SKELETON_GRACE_MS = 300;

/**
 * The rail's silhouette, in the rail's own order: groups of a short label over items, the way
 * `RailNav` draws Screener/Triage/Views. Label and item widths as a share of the column.
 */
const RAIL_GROUPS = [
  { label: 26, items: [58, 46, 52] },
  { label: 34, items: [44, 56, 38, 50] },
  { label: 30, items: [48, 40] },
] as const;

/**
 * Per row, `.row`'s three lines: the sender (`.who`), the subject (`.subj`), the preview
 * (`.prev`) — each as a share of the row's text column, beside the 30px lead circle.
 */
const ROW_BARS = [
  [34, 62, 84],
  [27, 74, 68],
  [41, 58, 76],
  [30, 70, 88],
  [37, 66, 62],
  [25, 54, 80],
  [39, 71, 71],
] as const;

/** One mail row's silhouette — `.srow`'s anatomy: lead circle, then the three text lines. */
function RowShape({ bars }: { bars: readonly [number, number, number] }) {
  const [who, subj, prev] = bars;
  return (
    <div className="boot-sk-row">
      <span className="boot-sk-av" />
      <span className="boot-sk-main">
        <span className="boot-sk-top">
          <span className="boot-sk-bar boot-sk-who" style={{ width: `${who}%` }} />
          <span className="boot-sk-bar boot-sk-time" />
        </span>
        <span className="boot-sk-bar boot-sk-subj" style={{ width: `${subj}%` }} />
        <span className="boot-sk-bar boot-sk-line" style={{ width: `${prev}%` }} />
      </span>
    </div>
  );
}

export function BootSkeleton({
  /**
   * Is the surface still waiting? `false` disarms AND resets the grace, so a surface that
   * finishes and later waits again gets a fresh one rather than appearing instantly on the
   * strength of an earlier wait.
   */
  active,
  /**
   * Draw the WHOLE WINDOW — rail, list panel with its head, reading-pane frame.
   *
   * True where the silhouette IS the window — the standalone client before an engine has served,
   * which has nothing else on screen. False in a browser tab, where the rail, the panel and the
   * view head are real, populated and already rendered: there only the ROWS are unknown, and a
   * second fake copy of any real surface would be the one thing this component is not allowed
   * to be.
   */
  rail = false,
  rows = ROW_BARS.length,
}: {
  active: boolean;
  rail?: boolean;
  rows?: number;
}) {
  const show = useLoadingGrace(active, BOOT_SKELETON_GRACE_MS);
  if (!show) return null;
  if (!rail) {
    // IN A LIST'S EMPTY BLOCK: rows alone, in the rows' own geometry, where the rows will be.
    return (
      <div className="boot-sk" aria-hidden="true">
        <div className="boot-sk-list">
          {ROW_BARS.slice(0, rows).map((b, i) => <RowShape key={i} bars={b} />)}
        </div>
      </div>
    );
  }
  return (
    <div className="boot-sk boot-sk-window" aria-hidden="true">
      {/* The NARROW shell's topbar, as shape — rendered always, shown only ≤900px (where the
          rail and reader silhouettes hide): without it a long narrow boot ended with the real
          topbar appearing and every row shifting down. Wordmark bar left, one capsule right. */}
      <div className="boot-sk-topbar">
        <span className="boot-sk-bar boot-sk-mark" />
        <span className="boot-sk-tb-btn" />
      </div>
      <div className="boot-sk-rail">
        {/* The wordmark slot, the compose capsule, then the nav groups — `rail.css`'s order. */}
        <span className="boot-sk-bar boot-sk-mark" />
        <span className="boot-sk-pill" />
        {RAIL_GROUPS.map((g, gi) => (
          <div className="boot-sk-group" key={gi}>
            <span className="boot-sk-bar boot-sk-label" style={{ width: `${g.label}%` }} />
            {g.items.map((w, i) => (
              <span className="boot-sk-item" key={i}>
                <span className="boot-sk-dot" />
                <span className="boot-sk-bar" style={{ width: `${w}%` }} />
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="boot-sk-list boot-sk-pane">
        {/* `.vhead`'s title row — a short title-weight bar and a longer meta one. */}
        <div className="boot-sk-head">
          <span className="boot-sk-bar boot-sk-h1" />
          <span className="boot-sk-bar boot-sk-meta" />
        </div>
        <div className="boot-sk-rows">
          {ROW_BARS.slice(0, rows).map((b, i) => <RowShape key={i} bars={b} />)}
        </div>
      </div>
      {/* The unselected reading column: a quiet panel, exactly as `ReadColumn` renders empty. */}
      <div className="boot-sk-reader" />
    </div>
  );
}
