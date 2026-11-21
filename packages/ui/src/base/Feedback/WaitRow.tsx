import { Icon } from "../../icons/Icon.js";
import { Button } from "../Primitives/Button.js";
import "./wait-row.css";

export interface WaitRowProps {
  /** What waits. */
  what: string;
  /** About which letter, where it is about one. */
  about?: string;
  /** Why it waits, or why it was not applied. */
  why: string;
  /** It was refused: the reason stands in ink, with the warning sign. */
  refused?: boolean;
  /** Its own answers: the first a second button, the other a word. */
  acts?: readonly { label: string; onPress: () => void; busy?: boolean }[];
}

/** One thing that waits, in the list of what waits: what, about which letter, why, and its own answers. */
export function WaitRow({ what, about, why, refused, acts }: WaitRowProps) {
  return (
    <div className="oh-waitrow" role="listitem" data-refused={refused ? "" : undefined}>
      <p className="oh-text oh-waitrow-say">
        <b className="oh-waitrow-what">{what}</b>
        {about ? <span className="oh-waitrow-about">{about}</span> : null}
        <span className="oh-waitrow-why">
          {refused ? <Icon name="warn" size={16} /> : null}
          <span>{why}</span>
        </span>
      </p>
      {acts?.length ? (
        <span className="oh-waitrow-acts">
          {acts.map((act, i) => (
            <Button key={act.label} size="s" kind={i ? "quiet" : "two"} onPress={act.onPress} busy={act.busy}>
              {act.label}
            </Button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
