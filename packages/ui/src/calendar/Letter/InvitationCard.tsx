import type { ReactNode } from "react";
import { Button } from "../../base/Primitives/Button.js";
import { CalendarSquare } from "../Grids/CalendarSquare.js";
import type { CalendarTone } from "../tone.js";
import "./invitation-card.css";

export interface InvitationCardProps {
  /** What it is: "Invitation", "New time proposed". */
  kind: string;
  title: string;
  /** The time in full, and the time it replaced, struck before it. */
  when: string;
  was?: string;
  /** The place, who it is from: a quiet line each. */
  lines?: readonly string[];
  /** What stands around it, two lines at most: the neighbour's square, its time and title, and a tag (overlaps, free). */
  around?: readonly { tone?: CalendarTone; text: string; tag: string }[];
  /** The answer: the answer switch. Left out for a sender who still waits at the door. */
  answers?: ReactNode;
  /** Where it goes: a sentence that is a control, with the calendar as a slot and its dot. */
  goes?: ReactNode;
  /** The way to the event on the calendar, as a word. */
  show?: { label: string; onPress?: () => void };
}

/**
 * An invitation, in the letter it came in: answered where it is read. The answer goes to its
 * sender at once, so there is no second place for it in mail.
 */
export function InvitationCard({
  kind,
  title,
  when,
  was,
  lines,
  around,
  answers,
  goes,
  show,
}: InvitationCardProps) {
  return (
    <div className="oh-invcard">
      <p className="oh-text oh-invcard-kind">{kind}</p>
      <h3 className="oh-text oh-display oh-invcard-title">{title}</h3>
      <p className="oh-text oh-invcard-when">
        {was ? <s className="oh-invcard-was">{was}</s> : null}
        {when}
      </p>
      {lines?.map((line, i) => (
        <p key={i} className="oh-text oh-invcard-line">
          {line}
        </p>
      ))}
      {around?.map((a, i) => (
        <p key={i} className="oh-text oh-invcard-around">
          {a.tone === undefined ? null : <CalendarSquare tone={a.tone} />}
          <span>{a.text}</span>
          <span className="oh-tag oh-invcard-tag">{a.tag}</span>
        </p>
      ))}
      {answers ? <div className="oh-invcard-answers">{answers}</div> : null}
      {goes || show ? (
        <div className="oh-invcard-foot">
          {goes ? <span className="oh-invcard-goes">{goes}</span> : null}
          <span className="oh-invcard-room" />
          {show ? (
            <Button kind="quiet" size="s" onPress={show.onPress}>
              {show.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
