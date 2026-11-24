import { Button } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import "./warn-row.css";

export interface WarnRowProps {
  /** What went wrong, as one whole sentence. */
  children: string;
  /** The way on. `busy`: it is being tried, and the label says so. */
  way?: { label: string; busy?: boolean; onPress?: () => void };
}

/** A refusal in ink, bold, with the warning sign, and the way on beside it. */
export function WarnRow({ children, way }: WarnRowProps) {
  const warn = (
    <p className="oh-text oh-warnrow-warn" role="alert">
      <Icon name="warn" size={18} />
      <span className="oh-warnrow-words">{children}</span>
    </p>
  );
  if (!way) return warn;
  return (
    <div className="oh-warnrow" aria-busy={way.busy || undefined}>
      {warn}
      <Button kind="two" size="s" busy={way.busy} onPress={way.onPress}>
        {way.label}
      </Button>
    </div>
  );
}
