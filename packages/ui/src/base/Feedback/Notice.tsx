import { Button } from "../Primitives/Button.js";
import { EndDot } from "../Primitives/EndDot.js";
import "./notice.css";

export interface NoticeAct {
  label: string;
  onPress: () => void;
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
  return (
    <div className="oh-notice" role="status" data-place={place}>
      <p className="oh-text oh-notice-say">
        <b className="oh-notice-title">
          <EndDot kind={hot ? "hot" : "ink"}>{title}</EndDot>
        </b>
        {line ? ` ${line}` : null}
      </p>
      {acts ? (
        <div className="oh-notice-acts">
          {acts.map((act, i) => (
            <Button key={act.label} size="s" kind={i ? "quiet" : "ink"} onPress={act.onPress}>
              {act.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
