import { Button } from "../Primitives/Button.js";
import { EndDot } from "../Primitives/EndDot.js";
import { useSaidOnArrival } from "../said-on-arrival.js";
import "./notice.css";

export interface NoticeAct {
  label: string;
  onPress: () => void;
  /** Off: while the notice's other answer is under way. */
  disabled?: boolean;
  /**
   * Under way after its own press: the answer stays where it is, off to a second press and said busy, and the keys
   * of the person who pressed it stay on it. An answer taken away while it runs drops them onto the page.
   */
  busy?: boolean;
}

export interface NoticeProps {
  /** Where the one slot is: the rail's foot, or the bar over a list where no rail stands. */
  place: "rail" | "bar";
  /** What is true, in six words or fewer. It ends in the dot. */
  title: string;
  /** Hot while it needs you. */
  hot?: boolean;
  /** At most one line: what is wrong and what to do. */
  line?: string;
  /** Up to two answers: the first a small capsule, the second a word. Left out where nothing can be done: it stands calm. */
  acts?: readonly [NoticeAct] | readonly [NoticeAct, NoticeAct];
}

/** Something needs you. It stands in the one slot, one at a time. */
export function Notice({ place, title, hot, line, acts }: NoticeProps) {
  /* Said when it appears: its words are given to a screen reader once the region stands; its answers at once. */
  const held = useSaidOnArrival(true) ? true : undefined;
  return (
    <div className="oh-notice" role="status" data-place={place}>
      <p className="oh-text oh-notice-say" aria-hidden={held}>
        <b className="oh-notice-title">
          <EndDot kind={hot ? "hot" : "ink"}>{title}</EndDot>
        </b>
        {line ? ` ${line}` : null}
      </p>
      {acts ? (
        <div className="oh-notice-acts">
          {acts.map((act, i) => (
            <Button
              key={act.label}
              size="s"
              kind={i ? "quiet" : "ink"}
              onPress={act.onPress}
              disabled={act.disabled}
              busy={act.busy}
            >
              {act.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
