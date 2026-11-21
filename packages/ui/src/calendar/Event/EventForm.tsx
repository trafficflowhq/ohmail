import type { ChangeEvent, MouseEventHandler, ReactNode, Ref } from "react";
import { Avatar, Button, Slot, Switch, type SuggestionField } from "../../base/index.js";
import { Icon, type IconName } from "../../icons/Icon.js";
import { CalendarSquare } from "../Grids/CalendarSquare.js";
import type { CalendarTone } from "../tone.js";
import "../../base/Primitives/slot.css";
import "./event-form.css";

/** One thing in a row of the form. A row is made of these, in the order given. */
export type EventFormItem =
  /** A word that opens a menu: the day, the repeat, the calendar. `none`: nothing chosen yet. `fill`: a proposal to take. */
  | {
      kind: "slot";
      value: string;
      label: string;
      state?: "fill" | "none" | "done";
      disabled?: boolean;
      hidden?: boolean;
      expanded?: boolean;
      onPress?: MouseEventHandler<HTMLButtonElement>;
    }
  /** A proposal you take by pressing it: an invitee the typed line named. It opens no menu. */
  | { kind: "take"; value: string; label: string; onPress?: () => void }
  /** A time, typed. */
  | {
      kind: "time";
      value: string;
      label: string;
      onChange?: (value: string) => void;
      cue?: { word: string; expanded: boolean; onPress: MouseEventHandler<HTMLButtonElement> };
    }
  /**
   * One line of text: the place. `suggests`: it offers while it is typed in, and is then the combobox of a
   * suggestion list (what `useSuggestions` hands for its field, which carries the text and its change); `ref`
   * is the field itself, for the list to stand at.
   */
  | {
      kind: "text";
      value: string;
      label: string;
      placeholder?: string;
      onChange?: (value: string) => void;
      suggests?: SuggestionField;
      ref?: Ref<HTMLInputElement>;
    }
  /** Several lines: the notes. Enter is a new line here. */
  | { kind: "notes"; value: string; label: string; placeholder?: string; onChange?: (value: string) => void }
  /** A quiet word between two things: "to", "Invite". */
  | { kind: "word"; text: string }
  /** A quiet line that is cut where the row ends: a call's address. */
  | { kind: "note"; text: string }
  /** A switch with its name, at the row's end: All day. */
  | { kind: "switch"; label: string; on: boolean; onChange?: (on: boolean) => void }
  /** A word that is on or off: Private. */
  | { kind: "toggle"; label: string; icon?: IconName; on: boolean; onChange?: (on: boolean) => void }
  /** An invitee: the name opens what can be said about them; `note` stands after the name ("optional"). */
  | {
      kind: "person";
      name: string;
      address: string;
      note?: string;
      label?: string;
      declined?: boolean;
      expanded?: boolean;
      onPress?: MouseEventHandler<HTMLButtonElement>;
      remove?: { label: string; onPress?: () => void };
    }
  /** A file or a link the event carries. */
  | {
      kind: "file";
      name: string;
      size?: string;
      link?: boolean;
      remove?: { label: string; onPress?: () => void };
    }
  /** A word that leads out: Open in Maps. */
  | { kind: "link"; text: string; onPress?: () => void }
  /** Takes away what the row holds: the call. */
  | { kind: "remove"; label: string; onPress?: () => void };

export interface EventFormRow {
  id: string;
  /** What leads the row: a glyph, or the square of the calendar it goes to. */
  icon?: IconName;
  mark?: CalendarTone;
  items: readonly EventFormItem[];
}

export interface EventFormProps {
  /** The rows that hold something, in the form's fixed order. */
  rows: readonly EventFormRow[];
  /** What is still empty waits as a word in the last line. `label` names it where the word is shorter. */
  adds?: readonly {
    id: string;
    word: string;
    label?: string;
    icon: IconName;
    onPress?: MouseEventHandler<HTMLButtonElement>;
  }[];
  /** The rest of what can be added, behind one glyph. */
  more?: { label: string; expanded?: boolean; onPress?: () => void };
  cancel?: { label: string; disabled?: boolean; onPress?: () => void };
  /** Add or Save, at the last line's end. */
  submit?: { label: string; keyHint?: string; disabled?: boolean; onPress?: () => void };
}

function remove(r: { label: string; onPress?: () => void }, key?: number): ReactNode {
  return (
    <button
      key={key}
      type="button"
      className="oh-control oh-evform-x"
      aria-label={r.label}
      title={r.label}
      onClick={r.onPress}
    >
      <Icon name="x" size={16} className="oh-evform-x-ico" />
    </button>
  );
}

/** A field: a time, a line of words, or the notes. */
function field(it: Extract<EventFormItem, { kind: "time" | "text" | "notes" }>, key: number): ReactNode {
  switch (it.kind) {
    case "time": {
      const input = (
        <input
          key={key}
          className="oh-control oh-evform-field"
          data-kind="time"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={it.value}
          aria-label={it.label}
          onChange={(e) => it.onChange?.(e.target.value)}
        />
      );
      return (
        <div key={key} className="oh-evform-timed">
          {input}
          {it.cue && (
            <button
              type="button"
              className="oh-control oh-evform-cue"
              aria-haspopup="dialog"
              aria-expanded={it.cue.expanded}
              onClick={it.cue.onPress}
            >
              {it.cue.word}
            </button>
          )}
        </div>
      );
    }
    case "text":
      return (
        <input
          key={key}
          ref={it.ref}
          className="oh-control oh-evform-field"
          type="text"
          spellCheck={false}
          placeholder={it.placeholder}
          aria-label={it.label}
          {...(it.suggests ?? {
            autoComplete: "off",
            value: it.value,
            onChange: (e: ChangeEvent<HTMLInputElement>) => it.onChange?.(e.target.value),
          })}
        />
      );
    case "notes":
      return (
        <textarea
          key={key}
          className="oh-control oh-evform-field"
          data-kind="notes"
          rows={2}
          spellCheck={false}
          value={it.value}
          placeholder={it.placeholder}
          aria-label={it.label}
          onChange={(e) => it.onChange?.(e.target.value)}
        />
      );
  }
}

/** A person or a file the event holds, with the way to take it off. */
function held(it: Extract<EventFormItem, { kind: "person" | "file" }>, key: number): ReactNode {
  switch (it.kind) {
    case "person":
      return (
        <span key={key} className="oh-evform-who" data-declined={it.declined ? "" : undefined}>
          <button
            type="button"
            className="oh-control oh-evform-name"
            aria-haspopup="menu"
            aria-expanded={it.expanded ?? false}
            aria-label={it.label}
            onClick={it.onPress}
          >
            <Avatar name={it.name} address={it.address} size="xs" />
            <span className="oh-evform-name-text">{it.name}</span>
            {it.note ? <small className="oh-evform-name-note">{it.note}</small> : null}
          </button>
          {it.remove ? remove(it.remove) : null}
        </span>
      );
    case "file":
      return (
        <span key={key} className="oh-evform-who" data-file="">
          <Icon name={it.link ? "go" : "clip"} size={16} className="oh-evform-file-ico" />
          <span className="oh-evform-name-text">{it.name}</span>
          {it.size ? <small className="oh-evform-name-note">{it.size}</small> : null}
          {it.remove ? remove(it.remove) : null}
        </span>
      );
  }
}

function item(it: EventFormItem, key: number): ReactNode {
  switch (it.kind) {
    case "slot":
      return it.hidden ? null : (
        <Slot
          key={key}
          kind={it.state}
          label={it.label}
          expanded={it.expanded}
          disabled={it.disabled}
          onPress={it.onPress}
        >
          {it.value}
        </Slot>
      );
    case "take":
      return (
        <button
          key={key}
          type="button"
          className="oh-control oh-slot"
          data-kind="fill"
          aria-label={it.label}
          title={it.label}
          onClick={it.onPress}
        >
          {it.value}
        </button>
      );
    case "time":
    case "text":
    case "notes":
      return field(it, key);
    case "word":
      return (
        <span key={key} className="oh-evform-word">
          {it.text}
        </span>
      );
    case "note":
      return (
        <span key={key} className="oh-evform-note">
          {it.text}
        </span>
      );
    case "switch":
      return (
        <label key={key} className="oh-evform-switch">
          <span aria-hidden="true">{it.label}</span>
          <Switch label={it.label} on={it.on} onChange={it.onChange} />
        </label>
      );
    case "toggle":
      return (
        <button
          key={key}
          type="button"
          className="oh-control oh-evform-toggle"
          role="switch"
          aria-checked={it.on}
          onClick={() => it.onChange?.(!it.on)}
        >
          {it.icon ? <Icon name={it.icon} size={16} className="oh-evform-toggle-ico" /> : null}
          <span>{it.label}</span>
        </button>
      );
    case "person":
    case "file":
      return held(it, key);
    case "link":
      return (
        <button key={key} type="button" className="oh-control oh-evform-link" onClick={it.onPress}>
          {it.text}
        </button>
      );
    case "remove":
      return remove(it, key);
  }
}

/**
 * One form for a new event and for an edit: rows led by a glyph, in a fixed order. A row stands
 * only when it holds something; what is empty waits as a word in the last line.
 */
export function EventForm({ rows, adds, more, submit, cancel }: EventFormProps) {
  return (
    <div className="oh-evform">
      {rows.map((row) => (
        <div key={row.id} className="oh-evform-row">
          <span className="oh-evform-lead" aria-hidden="true">
            {row.mark !== undefined ? (
              <CalendarSquare tone={row.mark} />
            ) : row.icon ? (
              <Icon name={row.icon} size={20} className="oh-evform-lead-ico" />
            ) : null}
          </span>
          <div className="oh-evform-value">{row.items.map(item)}</div>
        </div>
      ))}
      {adds?.length || more || submit || cancel ? (
        <div className="oh-evform-last">
          <div className="oh-evform-adds">
            {adds?.map((a) => (
              <button
                key={a.id}
                type="button"
                className="oh-control oh-evform-add"
                aria-label={a.label}
                title={a.label}
                onClick={a.onPress}
              >
                <Icon name={a.icon} size={16} className="oh-evform-add-ico" />
                <span>{a.word}</span>
              </button>
            ))}
            {more ? (
              <button
                type="button"
                className="oh-control oh-evform-add"
                data-bare=""
                aria-label={more.label}
                title={more.label}
                aria-haspopup="menu"
                aria-expanded={more.expanded ?? false}
                onClick={more.onPress}
              >
                <Icon name="more" size={16} className="oh-evform-add-ico" />
              </button>
            ) : null}
          </div>
          {submit || cancel ? (
            <div className="oh-evform-verbs">
              {cancel && (
                <Button kind="quiet" size="s" disabled={cancel.disabled} onPress={cancel.onPress}>
                  {cancel.label}
                </Button>
              )}
              {submit && (
                <Button
                  size="s"
                  disabled={submit.disabled}
                  keyHint={submit.keyHint}
                  keyShown
                  onPress={submit.onPress}
                >
                  {submit.label}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
