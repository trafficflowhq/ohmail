import { useRef } from "react";
import { useMeasuredMark } from "../../base/measured-mark.js";
import { Icon } from "../../icons/Icon.js";
import "./draft-control.css";

export interface DraftControlProps {
  /** What a press does now, whole: "Draft reply", "Draft from your text", "Drafting", "Draft again". */
  label: string;
  /** Visible wording when the control is shown with its established accessible name. */
  word?: string;
  /**
   * The same in fewer words: "Draft from text". They are drawn where the foot is narrow, so that it keeps one
   * line, and wherever the whole would still be cut, whatever the foot's width, the language and the text size:
   * the control measures its own word. Its name stays the whole.
   */
  short?: string;
  /** What a press does, with its price, as the pointer's hint: "Draft reply · 15 credits". */
  title: string;
  shortcut?: string;
  /** Its price beside it, where the foot has room and credits are spent: "15 credits". */
  cost?: string;
  /** Nothing to draft from yet: it stands quiet, takes a press all the same, and the app says why. */
  idle?: boolean;
  /** It is drafting: the control rests and takes no press, and keeps the keys of the person who pressed it. */
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}

/** One press writes a draft into the editor. The word says what a press would do with what stands there. */
export function DraftControl({
  label,
  word = label,
  short,
  title,
  shortcut,
  cost,
  idle,
  busy,
  disabled,
  onPress,
}: DraftControlProps) {
  const control = useRef<HTMLButtonElement>(null);
  const whole = useRef<HTMLSpanElement>(null);
  /* Where the whole word would still be cut, whatever the foot's width, the control marks itself (`data-cut`). */
  useMeasuredMark(control, whole, "cut", Boolean(short));
  return (
    <span className="oh-draft" data-idle={idle ? "" : undefined}>
      {cost && !idle ? <span className="oh-draft-cost">{cost}</span> : null}
      <button
        ref={control}
        type="button"
        className="oh-control oh-draft-control"
        aria-label={label}
        aria-keyshortcuts={shortcut}
        title={title}
        aria-busy={busy || undefined}
        aria-disabled={idle || busy || undefined}
        disabled={disabled}
        onClick={busy ? undefined : onPress}
      >
        <Icon name="spark" size={18} />
        <span ref={whole} className="oh-draft-word" data-short={short ? "" : undefined}>
          {word}
        </span>
        {short ? <span className="oh-draft-short">{short}</span> : null}
      </button>
    </span>
  );
}
