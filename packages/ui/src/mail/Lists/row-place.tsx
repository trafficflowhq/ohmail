import type { MouseEvent } from "react";
import { Tag } from "../../base/index.js";
import "./row-place.css";

/**
 * Where a waiting sender's mail would go, at the end of the row's last line. A suggestion is the place's word
 * with its dot: one press accepts it, and with a pointer a second control beside it chooses another place.
 * Where nobody has a suggestion the word itself chooses. With neither press it is a plain label.
 */
export interface RowPlace {
  /** The place as its word ("News"); where nobody has a suggestion, what a press does ("Choose"). */
  word: string;
  /** A suggestion: one press accepts it. `label` says the press whole ("News and unsubscribe"). */
  accept?: { label: string; onPress?: () => void };
  /** The way to another place, named ("Choose a place"). It hands the pressed control: the menu opens there. */
  choose?: { label: string; expanded?: boolean; onPress?: (at: HTMLElement) => void };
}

const quiet = (event: { stopPropagation(): void }) => event.stopPropagation();

/**
 * The place's controls, or with `room` their box alone: the row keeps that room at the end of its last line,
 * and the controls stand over it beside the row (a button inside an option is no button to a screen reader).
 */
export function RowPlaceFace({ place, room }: { place: RowPlace; room?: boolean }) {
  const { word, accept, choose } = place;
  if (!accept && !choose) {
    return (
      <span className="oh-row-place" data-room={room ? "" : undefined} aria-hidden={room ? true : undefined}>
        <Tag>{word}</Tag>
      </span>
    );
  }
  if (room) {
    return (
      <span
        className="oh-row-place"
        data-room=""
        data-two={accept && choose ? "" : undefined}
        aria-hidden="true"
      >
        <span className="oh-row-place-word" data-kind={accept ? "fill" : "none"}>
          {word}
          {accept ? null : <i className="oh-row-place-arrow" />}
        </span>
        {accept && choose ? (
          <span className="oh-row-place-more">
            <i className="oh-row-place-arrow" />
          </span>
        ) : null}
      </span>
    );
  }
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    choose?.onPress?.(event.currentTarget);
  };
  const menu = { "aria-haspopup": "menu", "aria-expanded": choose?.expanded ?? false } as const;
  return (
    <span className="oh-row-place" data-two={accept && choose ? "" : undefined}>
      {accept ? (
        <button
          type="button"
          className="oh-control oh-row-place-word"
          data-kind="fill"
          aria-label={accept.label}
          title={accept.label}
          onClick={(event) => (quiet(event), accept.onPress?.())}
          onKeyDown={quiet}
        >
          {word}
        </button>
      ) : (
        <button
          type="button"
          className="oh-control oh-row-place-word"
          data-kind="none"
          aria-label={choose?.label}
          title={choose?.label}
          {...menu}
          onClick={open}
          onKeyDown={quiet}
        >
          {word}
          <i className="oh-row-place-arrow" aria-hidden="true" />
        </button>
      )}
      {accept && choose ? (
        <button
          type="button"
          className="oh-control oh-row-place-more"
          aria-label={choose.label}
          title={choose.label}
          {...menu}
          onClick={open}
          onKeyDown={quiet}
        >
          <i className="oh-row-place-arrow" aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}
