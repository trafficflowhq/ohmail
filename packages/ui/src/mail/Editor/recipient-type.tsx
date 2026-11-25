import { useId, useRef, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
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
  onCommit?: (line: string, value: string) => void;
  onTypeFocus?: (line: string, focused: boolean) => void;
  /** The line's own keys, for a key the suggestions did not use. */
  onKeys: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** A paste of several addresses, inserted at the selection (`RecipientsProps.onPaste`). */
  onPaste?: (line: string, text: string) => void;
}

/** What parts a pasted list: a line break, a tab, a comma, a semicolon. */
const SEVERAL = /[\n\t,;]/;

/**
 * Whether typed words (lower-cased, with an "@") complete to this address: it begins with them, and it does not run
 * on past a domain that already reads whole ("anna@example.com" is not "anna@example.com.elsewhere.example").
 */
function completes(address: string, typed: string): boolean {
  const whole = address.toLowerCase();
  return (
    whole.startsWith(typed) && !(whole[typed.length] === "." && typed.slice(typed.indexOf("@")).includes("."))
  );
}

/**
 * The place to type the next person of a line. Where people are offered it is a combobox: they stand under the
 * line, the name over the address, the first one on, and Enter, Tab or a press takes the one the keys are on. Words
 * with an "@" put on only a row whose address they begin, and an offered address typed out whole puts no one on:
 * Enter or Tab keeps it as typed.
 */
export function RecipientType({
  line,
  locked,
  suggest,
  more,
  onType,
  onCommit,
  onTypeFocus,
  onKeys,
  onPaste,
}: RecipientTypeProps) {
  const anchor = useRef<HTMLSpanElement | null>(null);
  const offers = suggest && !locked ? suggest : undefined;
  const typed = line.typed.trim().toLowerCase();
  /* Asked here only where the words could be an address; elsewhere the list asks when it opens. */
  const asked = offers && typed.includes("@") ? offers.people(line.typed, line.id) : undefined;
  /* The rows the typed words complete to stand first: a row can wear an address as its name. */
  const offered = asked && [
    ...asked.filter((person) => completes(person.address, typed)),
    ...asked.filter((person) => !completes(person.address, typed)),
  ];
  const suggestions = useSuggestions<Offered>({
    id: useId(),
    text: line.typed,
    onText: (text) => onType?.(line.id, text),
    own: (text) => [
      {
        rows: (offered ?? offers?.people(text, line.id) ?? []).map((person) => ({
          id: person.id,
          mark: <Avatar name={person.name} address={person.address} size="xs" />,
          primary: person.name,
          secondary: person.address,
          tag: person.tag,
          person,
        })),
      },
    ],
    /* The first person is on, unless the words are an address: then a row is on only where they complete to its
       address, and the words whole are the person. A row's name for an address can be one somebody else gave it. */
    free: offered
      ? offered.some((person) => person.address.toLowerCase() === typed) ||
        !offered.some((person) => completes(person.address, typed))
      : false,
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
        onFocus={() => onTypeFocus?.(line.id, true)}
        onBlur={(event) => {
          if (offers) suggestions.field.onBlur();
          const value = event.currentTarget.value;
          if (!locked && value.trim()) onCommit?.(line.id, value);
          onTypeFocus?.(line.id, false);
        }}
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
        <>
          <span ref={anchor} className="oh-recipients-suggest-anchor" />
          <SuggestionList {...suggestions.list} anchor={anchor} label={offers.label} flush popover />
        </>
      ) : null}
    </span>
  );
}
