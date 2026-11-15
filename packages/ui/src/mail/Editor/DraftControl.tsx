import { Icon } from "../../icons/Icon.js";
import "./draft-control.css";

export interface DraftControlProps {
  /** What a press does now, whole: "Draft reply", "Draft from your text", "Drafting", "Draft again". */
  label: string;
  /** The same in fewer words, for a foot too narrow for all of it: "Draft from text". Never cut instead. */
  short?: string;
  /** What a press does, with its price, as the pointer's hint: "Draft reply · 15 credits". */
  title: string;
  /** Its price beside it, where the foot has room and credits are spent: "15 credits". */
  cost?: string;
  /** Nothing to draft from yet: it stands quiet, takes a press all the same, and the app says why. */
  idle?: boolean;
  /** It is drafting: the control rests. */
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
}

/** One press writes a draft into the editor. The word says what a press would do with what stands there. */
export function DraftControl({
  label,
  short,
  title,
  cost,
  idle,
  busy,
  disabled,
  onPress,
}: DraftControlProps) {
  return (
    <span className="oh-draft" data-idle={idle ? "" : undefined}>
      {cost && !idle ? <span className="oh-draft-cost">{cost}</span> : null}
      <button
        type="button"
        className="oh-control oh-draft-control"
        aria-label={label}
        title={title}
        aria-busy={busy || undefined}
        aria-disabled={idle || undefined}
        disabled={disabled || busy}
        onClick={onPress}
      >
        <Icon name="spark" size={18} />
        <span className="oh-draft-word" data-short={short ? "" : undefined}>
          {label}
        </span>
        {short ? <span className="oh-draft-short">{short}</span> : null}
      </button>
    </span>
  );
}
