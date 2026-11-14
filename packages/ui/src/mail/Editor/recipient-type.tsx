import { useId, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { Avatar, Button, SuggestionList, useSuggestions, type SuggestionRow } from "../../base/index.js";
import "./recipients.css";

/** A person a line can take. */
export interface RecipientSuggestion {
  id: string;
  name: string;
  address: string;
  /** A word at the row's end: "wrote to you". */
  tag?: string;
}

/** The people offered while a line is typed in. */
export interface RecipientSuggest {
  /** The list's name, said to a screen reader: "Address suggestions". */
  label: string;
  /** The people a line can take for what is typed on it: answered at once, the likeliest first. */
  people: (typed: string, line: string) => readonly RecipientSuggestion[];
  /** One was taken: by a press, by Enter or by Tab. */
  onTake?: (line: string, person: RecipientSuggestion) => void;
}

interface Offered extends SuggestionRow {
  person: RecipientSuggestion;
}

export interface RecipientTypeProps {
  line: { id: string; label: string; typed: string };
  locked?: boolean;
  suggest?: RecipientSuggest;
  /** The way to the lines that are not shown yet, beside the place to type. */
  more?: { label: string; onPress?: () => void };
  onType?: (line: string, value: string) => void;
  /** The line's own keys, for a key the suggestions did not use. */
  onKeys: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** A paste of several addresses, inserted at the selection (`RecipientsProps.onPaste`). */
  onPaste?: (line: string, text: string) => void;
}

/** What parts a pasted list: a line break, a tab, a comma, a semicolon. */
const SEVERAL = /[\n\t,;]/;

/**
 * The place to type the next person of a line. Where people are offered it is a combobox: they stand under the
 * line, the name over the address, the first one on, and Enter, Tab or a press takes the one the keys are on.
 */
export function RecipientType({ line, locked, suggest, more, onType, onKeys, onPaste }: RecipientTypeProps) {
  const offers = suggest && !locked ? suggest : undefined;
  const suggestions = useSuggestions<Offered>({
    id: useId(),
    text: line.typed,
    onText: (text) => onType?.(line.id, text),
    own: (typed) => [
      {
        rows: (offers?.people(typed, line.id) ?? []).map((person) => ({
          id: person.id,
          mark: <Avatar name={person.name} address={person.address} size="xs" />,
          primary: person.name,
          secondary: person.address,
          tag: person.tag,
          person,
        })),
      },
    ],
    /* A line has no free text to protect: the first person is on. */
    free: false,
    onTake: (row) => offers?.onTake?.(line.id, row.person),
  });
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!offers || !suggestions.keys(event)) return onKeys(event);
    /* A person was taken with Tab: the caret stays on the line for the next one. */
    if (event.key === "Tab") event.preventDefault();
  };
  /* One line of text would drop a pasted column's breaks and run its addresses together: several are handed whole. */
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text");
    if (!onPaste || locked || !SEVERAL.test(text)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? line.typed.length;
    const end = input.selectionEnd ?? start;
    onPaste(line.id, line.typed.slice(0, start) + text + line.typed.slice(end));
  };
  const field = offers
    ? suggestions.field
    : ({
        autoComplete: "off",
        value: line.typed,
        onChange: (event: ChangeEvent<HTMLInputElement>) => onType?.(line.id, event.target.value),
      } as const);
  return (
    <span className="oh-recipients-type">
      <input
        className="oh-control oh-recipients-in"
        type="text"
        data-type={line.id}
        aria-label={line.label}
        spellCheck={false}
        readOnly={locked}
        {...field}
        onKeyDown={keys}
        onPaste={paste}
      />
      {more ? (
        <span className="oh-recipients-more">
          <Button kind="quiet" size="s" onPress={more.onPress}>
            {more.label}
          </Button>
        </span>
      ) : null}
      {offers ? (
        <span className="oh-recipients-suggest">
          <SuggestionList {...suggestions.list} label={offers.label} />
        </span>
      ) : null}
    </span>
  );
}
