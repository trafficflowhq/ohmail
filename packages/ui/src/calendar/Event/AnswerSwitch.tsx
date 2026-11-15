import type { MouseEventHandler } from "react";
import { Button } from "../../base/Primitives/Button.js";
import "../../base/Primitives/key-hint.css";
import { useSegFit, type SegFit } from "../../base/Primitives/Seg.js";
import "../../base/Primitives/seg.css";
import { Icon } from "../../icons/Icon.js";
import "./answer-switch.css";

export interface AnswerSwitchProps {
  /** The group's name: "Answer". It names everything the part holds: the three answers, the acts, Propose a time. */
  label: string;
  /** Yes, Maybe and No as one switch. `value` is `null` while the invitation waits. */
  answers?: {
    /** Each answer, with the key that gives it where the app has one: the kit draws the hint, the app listens. */
    options: readonly { value: string; label: string; keyHint?: string }[];
    value: string | null;
    onChange?: (value: string) => void;
  };
  /** What is no answer of three: Add and Dismiss on an event found in mail, Accept and Keep on a proposed time. */
  acts?: readonly {
    id: string;
    label: string;
    primary?: boolean;
    onPress?: MouseEventHandler<HTMLButtonElement>;
  }[];
  /** Propose a time. Off where the provider takes no proposal. */
  propose?: { label: string; disabled?: boolean; onPress?: MouseEventHandler<HTMLButtonElement> };
  /** What it stands on: the soft sheet (a list, a letter), or a sheet (the card's head, an open row). */
  on?: "soft" | "sheet";
  /**
   * How close the answers stand on touch, as on the segmented control. Left out: measured, closer
   * while they are wider than their line (a proposed time in a letter on the unfolded phone).
   */
  fit?: SegFit;
}

/**
 * The answer to an invitation, on the event itself. One part for the event's card, its row in a
 * list and the letter it came in. A second answer is the way back: it answers on an answered event too.
 * The three answers stand on the segmented control's track; the group is the whole row.
 */
export function AnswerSwitch({ label, answers, acts, propose, on = "soft", fit }: AnswerSwitchProps) {
  const [track, fits] = useSegFit(fit, answers?.options);
  /* The three answers alone are the group themselves; with more beside them the whole row is. */
  const alone = !!answers && !acts?.length && !propose;
  const group = { role: "group", "aria-label": label } as const;
  return (
    <div className="oh-ans" {...(alone ? null : group)} data-on={on}>
      {answers ? (
        <span ref={track} className="oh-seg" {...(alone ? group : null)} data-fit={fits}>
          {answers.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className="oh-control oh-seg-item"
              aria-pressed={option.value === answers.value}
              onClick={() => answers.onChange?.(option.value)}
            >
              {option.label}
              {/* The key is a hint beside the word, drawn by the stylesheet: no part of the answer's name or its text. */}
              {option.keyHint ? (
                <kbd className="oh-key" aria-hidden="true" data-key={option.keyHint} />
              ) : null}
            </button>
          ))}
        </span>
      ) : null}
      {acts?.map((a) => (
        <Button key={a.id} kind={a.primary ? "ink" : "two"} size="s" onPress={a.onPress}>
          {a.label}
        </Button>
      ))}
      {propose ? (
        <button
          type="button"
          className="oh-control oh-button oh-ans-propose"
          data-kind="quiet"
          data-size="s"
          aria-label={propose.label}
          disabled={propose.disabled}
          onClick={propose.onPress}
        >
          <Icon name="clock" size={16} className="oh-ans-clock" />
          <span className="oh-ans-word">{propose.label}</span>
        </button>
      ) : null}
    </div>
  );
}
