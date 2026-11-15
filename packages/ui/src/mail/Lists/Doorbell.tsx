import { KeyHint } from "../../base/index.js";
import "./doorbell.css";

export interface DoorbellProps {
  /** How many wait, as it is printed. The app leaves the doorbell out at zero. */
  count: string;
  /** Its name, with where it leads: "6 waiting, Screener". */
  label: string;
  /** The keys that go there. Drawn only where key hints are switched on. */
  keyHint?: string;
  keyShown?: boolean;
  /** Somebody just arrived: it knocks and rings out once. */
  ringing?: boolean;
  /** It opens a panel over the view, and whether that stands open. Left out: it leads to a place. */
  expanded?: boolean;
  onPress?: () => void;
}

/** How many wait at the door, and the way there: the one hot field in a head. */
export function Doorbell({ count, label, keyHint, keyShown, ringing, expanded, onPress }: DoorbellProps) {
  return (
    <button
      type="button"
      className="oh-control oh-display oh-doorbell"
      data-ringing={ringing ? "" : undefined}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onPress}
    >
      <span className="oh-doorbell-count">{count}</span>
      {keyHint && keyShown ? <KeyHint shown>{keyHint}</KeyHint> : null}
    </button>
  );
}
