import { Button } from "../../base/index.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./list-line.css";

export interface ListLineProps {
  /** What the list says of itself: "Loading more senders…", "That is everything on your mail server." */
  children?: string;
  /** A refusal: in the ink, bold, with the warning sign. */
  warn?: boolean;
  /** Something is being read: a screen reader hears it as a status that is busy. */
  busy?: boolean;
  /** Fine print at the list's end. */
  fine?: boolean;
  /** Its one press. `quiet`: a word that acts, where the line is no refusal. */
  act?: { label: string; quiet?: boolean; icon?: IconName; onPress?: () => void };
}

/**
 * What a list says about itself under its rows: what it is reading, why it could not, that this is all there
 * is, and the one press that goes on. A refusal and a reading are said when they appear.
 */
export function ListLine({ children, warn, busy, fine, act }: ListLineProps) {
  return (
    <p
      className="oh-text oh-listline"
      role={busy || warn ? "status" : undefined}
      aria-busy={busy ? true : undefined}
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
        <Button kind={act.quiet ? "quiet" : "two"} size="s" icon={act.icon} onPress={act.onPress}>
          {act.label}
        </Button>
      ) : null}
    </p>
  );
}
