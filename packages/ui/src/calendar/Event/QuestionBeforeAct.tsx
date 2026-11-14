import { Button, EndDot, Menu, MenuItem, type MenuProps } from "../../base/index.js";
import "./question-before-act.css";

export interface QuestionBeforeActProps {
  open: boolean;
  /** Esc, the close or a press beside it: nothing happened. */
  onClose: () => void;
  /** Where the act is: the event, or the control that asked. Never the middle of the window. */
  anchor: MenuProps["anchor"];
  /** The line that says the act: "Move to Wed 11 Nov, 18:30". It ends in the ink dot. */
  question: string;
  /** What follows from it: the series' rule, what the invitees will read. */
  follows?: string;
  /** A series: which of its events the act is for. Each line with its key. */
  scopes?: readonly { id: string; label: string; keyHint?: string; onPress?: () => void }[];
  /** An act that writes to invitees: a note to them, which may stay empty. */
  note?: { label: string; placeholder: string; value: string; onChange?: (value: string) => void };
  /** Whether to tell them. The first is the one the keys go to. Where a provider always tells, there is only one. */
  answers?: readonly { id: string; label: string; keyHint?: string; onPress?: () => void }[];
  /** The close's name. */
  cancel: string;
}

/**
 * The question before an act on a series, or one that writes to invitees. It is asked where the
 * act is, in the frame of a menu, and an act that concerns nobody else asks nothing.
 */
export function QuestionBeforeAct({
  open,
  onClose,
  anchor,
  question,
  follows,
  scopes,
  note,
  answers,
  cancel,
}: QuestionBeforeActProps) {
  return (
    <Menu open={open} onClose={onClose} anchor={anchor} label={question} kind="ask">
      <div className="oh-ask">
        <p className="oh-text oh-display oh-ask-question">
          <EndDot kind="ink">{question}</EndDot>
        </p>
        {follows ? <p className="oh-text oh-ask-follows">{follows}</p> : null}
        {scopes?.map((s) => (
          <MenuItem key={s.id} keyHint={s.keyHint} onPress={s.onPress}>
            {s.label}
          </MenuItem>
        ))}
        {note ? (
          <textarea
            className="oh-control oh-ask-note"
            rows={1}
            spellCheck={false}
            value={note.value}
            placeholder={note.placeholder}
            aria-label={note.label}
            onChange={(e) => note.onChange?.(e.target.value)}
          />
        ) : null}
        {answers?.length ? (
          <div className="oh-ask-answers">
            {answers.map((a, i) => (
              <Button
                key={a.id}
                kind={i === 0 ? "ink" : "two"}
                size="s"
                keyHint={a.keyHint}
                keyShown
                onPress={a.onPress}
              >
                {a.label}
              </Button>
            ))}
          </div>
        ) : null}
        <span className="oh-ask-close">
          <Button kind="quiet" size="s" icon="x" label={cancel} onPress={onClose} />
        </span>
      </div>
    </Menu>
  );
}
