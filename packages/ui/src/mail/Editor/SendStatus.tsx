import { Button } from "../../base/index.js";
import { useSaidOnArrival } from "../../base/said-on-arrival.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./send-status.css";

export interface SendStatusProps {
  /**
   * Where it stands. `top`: over the letter's lines, what happened to the draft. `foot`: over the
   * editor's foot, why it was not sent. `end` and `start`: one short line over the control it answers,
   * at the foot's far end (a draft that was refused) or at its near end (a file that was not attached).
   */
  place: "top" | "foot" | "end" | "start";
  /** The heavy words that lead, with their full stop: "Not sent.", "Nothing was sent." */
  verdict?: string;
  /** The reason, as one sentence. */
  children: string;
  /** The sign it wears where nothing went wrong: the quiet one, or the sign of the control it answers. Left out: the warning. */
  sign?: IconName;
  /** The remedy: the line's one press, or the two answers where ohmail cannot know. The second is a word that acts. */
  acts?: readonly { label: string; onPress?: () => void }[];
}

/** The line at a letter being written that says it was not sent, why, and what to do. The draft is kept. */
export function SendStatus({ place, verdict, children, sign = "warn", acts }: SendStatusProps) {
  const short = place === "end" || place === "start";
  /* Said when it appears: its words are given to a screen reader once the region stands; its answers at once. */
  const held = useSaidOnArrival(true) ? true : undefined;
  const buttons = acts?.map((act, at) => (
    <Button key={act.label} kind={at ? "quiet" : "two"} size="s" onPress={act.onPress}>
      {act.label}
    </Button>
  ));
  return (
    <p className="oh-text oh-sendstatus" role="status" data-place={place}>
      {short ? (
        <>
          <Icon name={sign} size={18} />
          <span className="oh-sendstatus-words" aria-hidden={held}>
            {children}
          </span>
          {buttons}
        </>
      ) : (
        <>
          <span className="oh-sendstatus-line">
            <Icon name={sign} size={18} />
            <span className="oh-sendstatus-words" aria-hidden={held}>
              {verdict ? <b className="oh-sendstatus-verdict">{verdict} </b> : null}
              {children}
            </span>
          </span>
          {buttons?.length ? <span className="oh-sendstatus-acts">{buttons}</span> : null}
        </>
      )}
    </p>
  );
}
