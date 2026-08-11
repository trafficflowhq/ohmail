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

/** The rail's bars, as a share of the column. Groups and their items, in the rail's own rhythm. */
const RAIL_BARS = [58, 34, 46, 40, 30, 52, 36, 44] as const;

/** Per row: the short line and the long one, as a share of the row. */
const ROW_BARS = [
  [34, 84],
  [27, 68],
  [41, 76],
  [30, 88],
  [37, 62],
  [25, 80],
  [39, 71],
] as const;

export function BootSkeleton({
  /**
   * Is the surface still waiting? `false` disarms AND resets the grace, so a surface that
   * finishes and later waits again gets a fresh one rather than appearing instantly on the
   * strength of an earlier wait.
   */
  active,
  /**
   * Draw the rail column too.
   *
   * True where the silhouette IS the window — the standalone client before an engine has served,
   * which has no rail on screen to stand next to. False in a browser tab, where the rail is real,
   * populated and already rendered: a second, fake one beside it would be the one thing this
   * component is not allowed to be.
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
  return (
    <div className="boot-sk" aria-hidden="true">
      {rail ? (
        <div className="boot-sk-rail">
          {RAIL_BARS.map((w, i) => (
            <span key={i} className="boot-sk-bar" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : null}
      <div className="boot-sk-list">
        {ROW_BARS.slice(0, rows).map(([who, line], i) => (
          <div className="boot-sk-row" key={i}>
            <span className="boot-sk-bar boot-sk-who" style={{ width: `${who}%` }} />
            <span className="boot-sk-bar boot-sk-line" style={{ width: `${line}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}
