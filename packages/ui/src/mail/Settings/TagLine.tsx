import type { KeyboardEvent, MouseEvent, ReactNode, Ref } from "react";
import { Field, TagDot } from "../../base/index.js";
import { SettingLine } from "./SettingLine.js";
import "./tag-line.css";

/** The name's field of a tag being written: one line, named by its label alone. */
export interface TagLineField {
  /** What names it to a screen reader: "Name", "New tag". */
  label: string;
  value: string;
  onChange?: (value: string) => void;
  /** What it says while empty: "Name a new tag". */
  placeholder?: string;
  name?: string;
  /** Enter: what the line's first word does (Save, Add). */
  onEnter?: () => void;
  /** The field itself, for the app to put the keys in it when the line turns written (Rename). */
  ref?: Ref<HTMLInputElement>;
  /** Esc: back to the tag at rest. The key stops here: what the line stands in (a dialog, the room) does not hear it too. */
  onEscape?: () => void;
}

interface TagLineShared {
  /** The tag's hue: its dot, in the colour button at rest or standing still before the field. */
  hue: number;
  /** The words that act, as one group at the line's end: Rename and Delete; Save and Cancel; Add. */
  acts?: ReactNode;
}

interface TagLineAtRest extends TagLineShared {
  /** The tag's name: the line is a group of that name. */
  name: string;
  /** The colour button: its name ("Colour of Pottery Project"), the press that opens the colours at it, and whether they are open (left out: shut). */
  colour: { label: string; onPress?: (anchor: HTMLElement) => void; expanded?: boolean };
  /** How much carries it, at the right: "4 messages". */
  value?: string;
  field?: never;
  refusal?: never;
}

interface TagLineWritten extends TagLineShared {
  /** The tag's name being written, or a new one: the field takes the name's place. */
  field: TagLineField;
  /** The refusal, under the whole line: "You already have “Paperwork”." The field is then invalid. */
  refusal?: string;
  name?: never;
  colour?: never;
  value?: never;
}

export type TagLineProps = TagLineAtRest | TagLineWritten;

/**
 * A tag on its sheet of settings. At rest: its colour as a round button with the tag's dot, its name, how much
 * carries it, and its two words as one group. Written: the dot standing still, the name's field at the line's height,
 * its words, and a refusal under the whole line.
 */
export function TagLine(props: TagLineProps) {
  const { hue, acts } = props;
  const words = acts ? <span className="oh-tagline-acts">{acts}</span> : null;
  if (props.field === undefined) {
    const { name, colour, value } = props;
    const press = colour.onPress
      ? (event: MouseEvent<HTMLButtonElement>) => colour.onPress?.(event.currentTarget)
      : undefined;
    return (
      <SettingLine
        label={name}
        value={value}
        narrow="under"
        lead={
          <button
            type="button"
            className="oh-control oh-tagline-hue"
            aria-label={colour.label}
            title={colour.label}
            aria-haspopup="menu"
            aria-expanded={colour.expanded ?? false}
            onClick={press}
          >
            <TagDot hue={hue} />
          </button>
        }
      >
        {words}
      </SettingLine>
    );
  }
  const { field, refusal } = props;
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    /* A word still being composed (an input method) ends with Enter: that Enter is the word's, not the line's. */
    if ((event.target as Element).tagName !== "INPUT" || event.nativeEvent.isComposing) return;
    if (event.key === "Enter") field.onEnter?.();
    else if (event.key === "Escape" && field.onEscape) {
      event.stopPropagation();
      field.onEscape();
    }
  };
  return (
    /* A refusal that appears while the keys stay in the field is said then (polite): the field alone says it only when the keys come to it. */
    <div className="oh-tagline" aria-live="polite" data-refused={refusal ? "" : undefined} onKeyDown={keys}>
      <span className="oh-tagline-hue" aria-hidden="true">
        <TagDot hue={hue} />
      </span>
      <Field
        label={field.label}
        value={field.value}
        onChange={field.onChange}
        placeholder={field.placeholder}
        name={field.name}
        ref={field.ref}
        refusal={refusal}
        bare
      />
      {words}
    </div>
  );
}
