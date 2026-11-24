import { Button } from "../../base/Primitives/Button.js";
import { Icon } from "../../icons/Icon.js";
import { CalendarSquare } from "../Grids/CalendarSquare.js";
import type { CalendarTone } from "../tone.js";
import "./found-event-row.css";

interface Way {
  label: string;
  onPress?: () => void;
}

export interface FoundEventRowProps {
  /** The day and the time. */
  when: string;
  title: string;
  /** The place under it; once added, where it is ("On your calendar"). */
  second?: string;
  /** A guess says so. */
  tag?: string;
  /** Found: the press that adds it, and the one that sends it away. */
  add?: Way;
  dismiss?: Way;
  /** Added, or on a calendar already: that calendar's colour, and the way to it. */
  on?: { tone: CalendarTone; show?: Way };
}

/**
 * An event found in a letter: offered once, above the words it came from, and added only on a
 * press. Found, it is dashed; on a calendar, it is solid and wears that calendar's square.
 */
export function FoundEventRow({ when, title, second, tag, add, dismiss, on }: FoundEventRowProps) {
  return (
    <div className="oh-found" data-on={on ? "" : undefined}>
      {on ? (
        <CalendarSquare tone={on.tone} size={12} />
      ) : (
        <Icon name="frommail" size={20} className="oh-found-ico" />
      )}
      <span className="oh-found-words">
        <b className="oh-found-when">{when}</b>
        {title}
        {tag ? <span className="oh-tag oh-found-tag">{tag}</span> : null}
        <span className="oh-found-second">{second}</span>
      </span>
      {on ? (
        on.show ? (
          <Button kind="quiet" size="s" onPress={on.show.onPress}>
            {on.show.label}
          </Button>
        ) : null
      ) : (
        <span className="oh-found-acts">
          {add ? (
            <button type="button" className="oh-control oh-slot" data-kind="fill" onClick={add.onPress}>
              {add.label}
            </button>
          ) : null}
          {dismiss ? (
            <Button kind="quiet" size="s" icon="x" label={dismiss.label} onPress={dismiss.onPress} />
          ) : null}
        </span>
      )}
    </div>
  );
}
