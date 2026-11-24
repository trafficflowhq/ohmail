import type { Ref } from "react";
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
  /**
   * It answers a press: said at once, and it can be handed the keys (the form brings it into view and puts the keys
   * on it through `ref`, so a person who pressed by the keyboard is where the answer is). Tab never stops on it.
   * Left out: a status, said when the reader is free.
   */
  alert?: boolean;
  ref?: Ref<HTMLParagraphElement>;
}

/** One line over a control that names why it did not act, with the one way on. Ink, bold, no colour, no box. */
export function RefusalLine({ children, icon, way, start, alert, ref }: RefusalLineProps) {
  return (
    <p
      ref={ref}
      className="oh-text oh-refusal"
      role={alert ? "alert" : "status"}
      tabIndex={alert ? -1 : undefined}
      data-start={start ? "" : undefined}
    >
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
