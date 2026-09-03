import type { ReactNode } from "react";
import "./bulk-strip.css";

/**
 * THE BULK STRIP — the row of verbs over a list, and the slots under it.
 *
 * The Screener's head is the one consumer today. Three things live here rather than in the
 * view so they are one shape wherever a list grows a bulk row: the verbs are ONE row of
 * same-height capsules; a run's progress is ONE construction (sentence + track); and asking
 * for something with a price is ONE well ({@link AskWell}). The view keeps its words and its
 * state machine — this is layout and state dress, nothing else.
 */
export interface BulkStripProps {
  /** The verbs — capsules, all at the decision bar's size. */
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}

export function BulkStrip({ children, className, ariaLabel }: BulkStripProps) {
  const cls = ["scn-bulk", className].filter(Boolean).join(" ");
  return (
    <div className={cls} role="group" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export interface BulkProgressProps {
  /** The sentence that states the two numbers ("Applying 7 of 40…"). Announced. */
  label: ReactNode;
  done: number;
  total: number;
  className?: string;
}

/**
 * A run's progress: the sentence, and the same two numbers as a track.
 *
 * The track is `aria-hidden` on purpose — the sentence beside it is the announcement, and a
 * labelled `<progress>` would narrate the same fact twice. Never rendered without a
 * denominator: a `total` of 0 would put an indeterminate bar on screen, a run that claims to be
 * in flight forever.
 */
export function BulkProgress({ label, done, total, className }: BulkProgressProps) {
  const cls = ["scn-applying", className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <span className="scn-applying-lab num" role="status">
        {label}
      </span>
      {total > 0 ? <progress className="scn-prog" aria-hidden="true" value={done} max={total} /> : null}
    </div>
  );
}

/** The well's state — the Send verb's vocabulary on the verb that spends. */
export type AskWellState = "idle" | "working" | "done" | "refused";

export interface AskWellProps {
  state: AskWellState;
  /** The question ("Suggest for the first"). */
  label: ReactNode;
  /** The choice beside it — a {@link SizeLadder}. */
  ladder?: ReactNode;
  /** The status line: the server's price, "Checking the price…", or nothing. Announced. */
  status?: ReactNode;
  /** The verbs, primary first; a progress track may ride the row's end. */
  actions: ReactNode;
  /** The server's own sentence, or the run's count. Announced. */
  note?: ReactNode;
  ariaLabel?: string;
  className?: string;
}

/**
 * THE ASK WELL — a question with a price, as one block.
 *
 * Label and ladder on the first line, the status under them, the verbs last, and the server's
 * sentence at the foot. It takes the strip's full width so the question never wraps into four
 * unrelated controls, and it wears `data-state` so the stylesheet and a test can name what the
 * ask is doing without reading the words.
 */
export function AskWell({ state, label, ladder, status, actions, note, ariaLabel, className }: AskWellProps) {
  const cls = ["scn-suggest", className].filter(Boolean).join(" ");
  return (
    <div className={cls} role="group" aria-label={ariaLabel} data-state={state} aria-busy={state === "working" || undefined}>
      <span className="scn-sg-lab">{label}</span>
      {ladder}
      <span className="scn-sg-price num" role="status">
        {status}
      </span>
      <div className="scn-sg-actions">{actions}</div>
      {note ? (
        <span className="scn-sg-note" role="status">
          {note}
        </span>
      ) : null}
    </div>
  );
}

export interface SizeLadderProps {
  sizes: number[];
  value: number;
  onChange: (size: number) => void;
  /** The label for a rung — "all 74" on the top one, the number otherwise. */
  labelOf: (size: number) => ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * The batch-size rungs, as the segmented control: one pressed rung floats on the track.
 * `aria-pressed` per rung — a toggle group, not a tablist; nothing changes view when pressed.
 */
export function SizeLadder({ sizes, value, onChange, labelOf, disabled, className }: SizeLadderProps) {
  const cls = ["seg", "scope", "scn-sg-sizes", className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      {sizes.map((n) => (
        <button
          key={n}
          type="button"
          className={n === value ? "scn-sg-size on" : "scn-sg-size"}
          aria-pressed={n === value}
          disabled={disabled}
          onClick={() => onChange(n)}
        >
          {labelOf(n)}
        </button>
      ))}
    </div>
  );
}
