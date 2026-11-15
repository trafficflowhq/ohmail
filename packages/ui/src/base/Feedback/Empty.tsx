import type { IconName } from "../../icons/Icon.js";
import { Button } from "../Primitives/Button.js";
import { Dot } from "../Primitives/Dot.js";
import { EndDot } from "../Primitives/EndDot.js";
import "./empty.css";

export interface EmptyProps {
  /** What the place says, once. It ends in the dot. */
  label: string;
  /** Hot while something waits. */
  hot?: boolean;
  /** The product's mark over the label, as its letters: only on the welcome and where everything is decided. */
  mark?: string;
  /** At most one button: it runs on a press, or it goes to an address as a link (a place that works before any script). */
  act?: { label: string; icon?: IconName } & (
    { onPress: () => void; href?: never } | { href: string; onPress?: never }
  );
}

/** A place with nothing in it says so, once: a label, a label and one button, or the mark with a label. */
export function Empty({ label, hot, mark, act }: EmptyProps) {
  return (
    <div className="oh-empty">
      {mark ? (
        <p className="oh-text oh-empty-mark" aria-label={`${mark}.`}>
          {mark}
          <Dot kind={hot ? "hot" : "ink"} />
        </p>
      ) : null}
      <p className="oh-text oh-display oh-empty-label">
        {mark ? (
          <>
            {label}
            <Dot kind="ink" />
          </>
        ) : (
          <EndDot kind={hot ? "hot" : "ink"}>{label}</EndDot>
        )}
      </p>
      {act ? (
        <div className="oh-empty-acts">
          {act.href !== undefined ? (
            <Button kind="two" icon={act.icon} href={act.href}>
              {act.label}
            </Button>
          ) : (
            <Button kind="two" icon={act.icon} onPress={act.onPress}>
              {act.label}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
