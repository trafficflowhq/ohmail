import type { ChangeEvent, KeyboardEvent, MouseEvent, Ref } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import { Avatar } from "./Avatar.js";
import type { SuggestionField } from "../Overlays/use-suggestions.js";
import { Button } from "./Button.js";
import "./find-field.css";

export interface FindFieldProps {
  /** Names the field to a screen reader: "Search". It is not drawn; the placeholder says what it finds. */
  label: string;
  value: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  /** The sign before the words. Left out: `search`. */
  sign?: IconName;
  /**
   * What the words are narrowed to, standing before them: a person with their circle, or a word of the app's.
   * It is one control, named by `remove` ("Remove Petra Wyss"): a press takes the narrowing off.
   */
  chip?: {
    label: string;
    person?: { name: string; address: string };
    remove: string;
    onRemove?: () => void;
  };
  /** What the search took or found, at the field's end, as it is printed: "0.12 s", "3 events". */
  took?: string;
  /** The control that empties the field; it stands only while there are words. */
  clear?: { label: string; onPress?: () => void };
  /**
   * It offers while it is typed in: what `useSuggestions` hands for its field, which then carries the text, its
   * change and the list's keys. An `onKeyDown` beside it takes the keys in their place and asks the list first.
   */
  suggests?: SuggestionField;
  /** The keys the app answers in the field: Enter, the arrows, Escape. */
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  ref?: Ref<HTMLInputElement>;
}

/**
 * The line a place is searched from: one row tall, a textbox with its sign before the words. It stands in no
 * form and carries no name of a form's: what is typed is the app's to ask with, never the browser's to keep.
 */
export function FindField(props: FindFieldProps) {
  const {
    label,
    value,
    onChange,
    placeholder,
    sign = "search",
    chip,
    took,
    clear,
    suggests,
    onKeyDown,
    ref,
  } = props;
  const typed = suggests ?? {
    autoComplete: "off",
    value,
    readOnly: !onChange,
    onChange: (event: ChangeEvent<HTMLInputElement>) => onChange?.(event.currentTarget.value),
  };
  /* A press on the box itself is a press on the field: the keys go to the words. */
  const toWords = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) event.currentTarget.querySelector("input")?.focus();
  };
  return (
    <div className="oh-findfield" data-chip={chip ? "" : undefined} onClick={toWords}>
      <Icon name={sign} size={20} />
      {chip ? (
        <button
          type="button"
          className="oh-control oh-findfield-chip"
          aria-label={chip.remove}
          title={chip.remove}
          onClick={chip.onRemove}
        >
          {chip.person ? <Avatar name={chip.person.name} address={chip.person.address} size="xs" /> : null}
          <b className="oh-findfield-chip-name">{chip.label}</b>
          <Icon name="x" size={16} />
        </button>
      ) : null}
      <input
        ref={ref}
        className="oh-control oh-findfield-input"
        type="text"
        aria-label={label}
        placeholder={placeholder}
        spellCheck={false}
        {...typed}
        {...(onKeyDown ? { onKeyDown } : null)}
      />
      {took ? (
        <span className="oh-findfield-took">
          <span>{took}</span>
        </span>
      ) : null}
      {clear && value ? (
        <Button kind="quiet" size="s" icon="x" label={clear.label} onPress={clear.onPress} />
      ) : null}
    </div>
  );
}
