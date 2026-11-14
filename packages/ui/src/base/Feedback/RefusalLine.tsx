import { Icon, type IconName } from "../../icons/Icon.js";
import { Button } from "../Primitives/Button.js";
import "./refusal-line.css";

export interface RefusalLineProps {
  /** Why it did not act: the cause first, in one line. */
  children: string;
  /** The sign before it. Left out: the warning sign. */
  icon?: IconName;
  /** The one way on. */
  way?: { label: string; onPress: () => void };
  /** At the line's start, and broken wherever it must: a file's name that does not fit. */
  start?: boolean;
}

/** One line over a control that names why it did not act, with the one way on. Ink, bold, no colour, no box. */
export function RefusalLine({ children, icon, way, start }: RefusalLineProps) {
  return (
    <p className="oh-text oh-refusal" role="status" data-start={start ? "" : undefined}>
      <Icon name={icon ?? "warn"} size={18} />
      <span className="oh-refusal-say">{children}</span>
      {way ? (
        <Button kind="two" size="s" onPress={way.onPress}>
          {way.label}
        </Button>
      ) : null}
    </p>
  );
}
