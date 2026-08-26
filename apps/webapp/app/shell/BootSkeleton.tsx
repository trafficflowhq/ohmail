"use client";

/**
 * THE SHAPE OF THE SCREEN THAT IS COMING — and nothing whatsoever about what will be on it.
 *
 * Two waits in this product are long enough that a person watching one has to be given
 * something, and both of them used to be a single centred sentence over an empty window:
 *
 *  · a STANDALONE FIRST LAUNCH that has to repair itself. An install whose previous run left a
 *    large write-ahead log replays it inside the mail engine's database open, before anything
 *    can serve. It is bounded by the size of that log rather than by the mailbox — measured at
 *    roughly a hundred seconds on a directory that had grown to tens of gigabytes. It happens
 *    ONCE: recovery ends in a checkpoint, and the engine now checkpoints on a timer while it
 *    runs, so no install made after that change accumulates a log like it again.
 *  · a COLD MIRROR in a browser tab. The first `/sync` page has not landed, so the mirror has
 *    not been read and the list is not empty — it is unknown. On a full mailbox the import
 *    behind it runs for minutes.
 *
 * ── THE GEOMETRY IS THE APP'S OWN, NOT A GENERIC ONE — owner report, 2026-08-26 ──────────
 *
 * The first cut of this drew "some skeleton text lines": eight bars for a rail and rows of two
 * anonymous lines, which is a wireframe of no window this product has ever shown. The desktop
 * boot renders it as THE WHOLE WINDOW, so the silhouette is a promise about what the window is
 * about to be — and a promise in the wrong shape is answered by a visible re-layout when the
 * real shell arrives. So every measure below is the live shell's own, by name:
 *
 *  · the three columns are `.deck`'s rail (224px) plus `.view.split`'s `--split`
 *    (`minmax(320px,400px) 1fr`) with the same 16px gaps — rail, list, reading pane, exactly
 *    where the real ones land;
 *  · the rail's insides follow `rail.css`: the wordmark slot, the compose capsule, then groups
 *    of a small label over items in `.ritem`'s own padding and rhythm;
 *  · the list is `.list-col`'s panel with `.vhead`'s title row, and each row is `.row`/`.srow`
 *    verbatim — the 30px lead avatar circle every Ohbox row draws, the sender line with the
 *    time stub at the right, the subject line, the preview line, at `.row`'s 12×14 padding;
 *  · the reading pane is what the real unselected `ReadColumn` is — a quiet lift-1 panel and
 *    nothing in it.
 *
 * The mobile port (`apps/mobile/src/ui/Skeleton.tsx`) reached this standard first — "the row
 * geometry mirrors the REAL list rows, so when content replaces the skeleton, nothing jumps" —
 * and this brings the origin up to its port.
 *
 * ── THIS WAS RULED OUT ONCE, ON THE SAME MEASUREMENT THAT NOW ARGUES FOR IT ──────────────
 *
 * The earlier reading was: an ordinary launch answers in well under a second now that the log is
 * bounded, so a loading skeleton would be a strobe on every healthy boot and buy nothing. That
 * reading was right about the ordinary launch and wrong to stop there — it settled the question
 * of what to draw at zero milliseconds, which is not the question. Both facts are true at once,
 * of different waits, and a constant cannot be right about both.
 *
 * So this is a function of TIME, exactly as `loading-grace.ts` is: below the grace nothing is
 * drawn and a sub-second boot is a quiet frame, as it has always been; above it the window
 * carries the geometry it is about to fill. The reversal costs one timer and the fast path is
 * byte-for-byte what it was.
 *
 * ── WHY THE GRACE IS SHORTER THAN THE SENTENCE'S ────────────────────────────────────────
 *
 * `LOADING_GRACE_MS` is 600 ms and gates WORDS. This one is 300 and gates SHAPE, and the
 * ordering is deliberate: a sentence appearing and being read is a demand on attention, while a
 * shape appearing under one is not, so the cheaper thing may arrive earlier. On a wait that
 * outlives both, the window fills in and then explains itself, which is the order those two
 * things want to happen in.
 *
 * ── AND IT MUST NEVER CARRY CONTENT. THIS IS THE PART THAT IS A RULE ────────────────────
 *
 * `OhboxView` has said for a long time that a placeholder row, an invented count or a skeleton
 * shaped like mail would answer a loading complaint by creating the worst failure this product
 * has: something plausible rendered as if it were the reader's own mail. That rule is not
 * relaxed here, it is the boundary this component is drawn on the safe side of. A silhouette
 * with zero text nodes in it cannot be mistaken for a message, a sender, a subject or a count,
 * because there is nothing in it to mistake. `aria-hidden` says the same thing to the other half
 * of the audience: the shape is not information, the sentence beside it is.
 *
 * The widths below are a fixed table rather than anything derived or random. Derived widths
 * would be content — a bar as long as a real subject line IS a claim about that subject — and
 * random ones would make the same render differ between two paints of one wait.
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
