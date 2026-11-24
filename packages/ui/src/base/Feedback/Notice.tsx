import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "../Primitives/Button.js";
import { EndDot } from "../Primitives/EndDot.js";
import { useSaidOnArrival } from "../said-on-arrival.js";
import { ActivityLine } from "./ActivityLine.js";
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
  /** A quiet act stays a word even when it is the only answer. */
  kind?: "quiet";
}

type NoticeButton = Omit<NoticeAct, "onPress"> & {
  onPress: MouseEventHandler<HTMLButtonElement>;
};

export interface NoticeProps {
  /** Where the one slot is: the rail's foot, or the bar over a list where no rail stands. */
  place: "rail" | "bar";
  /** What is true, in six words or fewer. It ends in the dot. */
  title: string;
  /** Hot while it needs you. */
  hot?: boolean;
  /** Draw a waiting line and put the count below the title. */
  progress?: boolean;
  /** At most one line of detail or a progress count. */
  line?: ReactNode;
  /** Up to two answers: the first a small capsule, the second a word. Left out where nothing can be done: it stands calm. */
  acts?: readonly [NoticeButton] | readonly [NoticeButton, NoticeButton];
  /** Related controls when the notice must keep existing ways to act. */
  related?: ReactNode;
  /** Keep the title visible while folding away the detail and its actions. */
  disclosure?: { collapsed: boolean; label: string; onPress: () => void };
}

/** Something needs you. It stands in the one slot, one at a time. */
export function Notice({ place, title, hot, progress, line, acts, related, disclosure }: NoticeProps) {
  /* Said when it appears: its words are given to a screen reader once the region stands; its answers at once. */
  const held = useSaidOnArrival(true) ? true : undefined;
  const collapsed = disclosure?.collapsed === true;
  return (
    <div
      className="oh-notice"
      role="status"
      data-place={place}
      data-progress={progress || undefined}
      data-collapsed={collapsed || undefined}
    >
      <p className="oh-text oh-notice-say" aria-hidden={held}>
        <b className="oh-notice-title">
          <EndDot kind={hot || progress ? "hot" : "ink"}>{title}</EndDot>
        </b>
        {!collapsed &&
          line &&
          (progress ? (
            <>
              {" "}
              <span className="oh-notice-count">{line}</span>
            </>
          ) : (
            <> {line}</>
          ))}
      </p>
      {progress ? <ActivityLine /> : null}
      {acts || disclosure ? (
        <div className="oh-notice-acts">
          {!collapsed &&
            acts?.map((act, i) => (
              <Button
                key={act.label}
                size="s"
                kind={act.kind ?? (i ? "quiet" : "ink")}
                onPress={act.onPress}
                disabled={act.disabled}
                busy={act.busy}
              >
                {act.label}
              </Button>
            ))}
          {disclosure ? (
            <Button size="s" kind="quiet" expanded={!collapsed} onPress={disclosure.onPress}>
              {disclosure.label}
            </Button>
          ) : null}
        </div>
      ) : null}
      {!collapsed && related ? <div className="oh-notice-acts oh-notice-related">{related}</div> : null}
    </div>
  );
}
