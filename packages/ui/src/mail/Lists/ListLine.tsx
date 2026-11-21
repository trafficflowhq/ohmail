import { useRef, type ReactNode } from "react";
import { Button } from "../../base/index.js";
import { useMeasuredMark } from "../../base/measured-mark.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./list-line.css";

export interface ListLineProps {
  /** What the list says of itself: "Loading more senders…", "That is everything on your mail server." */
  children?: ReactNode;
  /** A refusal: in the ink, bold, with the warning sign. */
  warn?: boolean;
  /** Something is being read: said when it appears. */
  busy?: boolean;
  /** A verdict that is neither a refusal nor a reading, said when it appears: "Nothing in Junk matches." */
  said?: boolean;
  /** Fine print at the list's end. */
  fine?: boolean;
  /**
   * Its one press. `quiet`: a word that acts, where the line is no refusal. A quiet press whose words are wider
   * than the line takes a second line inside the list (the line measures it); one that fits is the small button.
   */
  act?: { label: string; quiet?: boolean; icon?: IconName; onPress?: () => void };
}

/**
 * What a list says about itself under its rows: what it is reading, why it could not, that this is all there
 * is, and the one press that goes on. A refusal, a reading and a verdict are said when they appear: as a
 * status that never calls itself busy, which would ask a screen reader to wait with what the line holds.
 */
export function ListLine({ children, warn, busy, said, fine, act }: ListLineProps) {
  const press = useRef<HTMLButtonElement>(null);
  useMeasuredMark(press, press, "fold", Boolean(act?.quiet));
  return (
    <p
      className="oh-text oh-listline"
      role={busy || warn || said ? "status" : undefined}
      data-warn={warn ? "" : undefined}
      data-fine={fine ? "" : undefined}
    >
      {children ? (
        <span className="oh-listline-say">
          {warn ? <Icon name="warn" size={18} /> : null}
          <span className="oh-listline-words">{children}</span>
        </span>
      ) : null}
      {act ? (
        <Button ref={press} kind={act.quiet ? "quiet" : "two"} size="s" icon={act.icon} onPress={act.onPress}>
          {act.label}
        </Button>
      ) : null}
    </p>
  );
}
