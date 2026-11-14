import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Button, Tag } from "../../base/index.js";
import { Icon } from "../../icons/Icon.js";
import { RecipientChip, type RecipientPerson } from "./RecipientChip.js";
import { RecipientType, type RecipientSuggest } from "./recipient-type.js";
import "./recipients.css";
import { useRecipientDrag, type Landing } from "./recipient-drag.js";

/** One line of people: To, Cc, Bcc. */
export interface RecipientLine {
  id: string;
  label: string;
  people: readonly RecipientPerson[];
  /** What is being typed after the last person. */
  typed: string;
}

export interface RecipientsProps {
  /**
   * The mailbox it goes from: a slot to choose it, or the address as plain words; its tag; the draft's state at the
   * line's end, a status a screen reader hears. `stateId`: the state's id, so that the chooser it is about can name it
   * as its description (the kit's `Slot` `describedBy`); left out, it has one of its own.
   */
  from?: {
    label: string;
    value: ReactNode;
    tag?: string;
    state?: string;
    stateId?: string;
    long?: boolean;
    /** The editor's current state, with its draft-saving message when it applies. */
    stamp?: { label?: string; hint?: string };
  };
  lines: readonly RecipientLine[];
  /** A reply's recipients, folded into names until they are changed. */
  folded?: { label: string; names: string; change: { label: string; onPress?: () => void } };
  /** The way to the lines that are not shown yet, at the first line's end: "Cc Bcc". */
  more?: { label: string; onPress?: () => void };
  /** The people a line can take while it is typed in: its place to type is then a combobox, and they stand under the line. */
  suggest?: RecipientSuggest;
  /** What was refused, as one line under the people: "Not an address: petra@makersfest". Said with each refused person. */
  refusal?: string;
  subject?: {
    label: string;
    placeholder: string;
    value: string;
    onChange?: (value: string) => void;
    /** Escape in the subject: the way out it is handed (a reply's: back to its text), taken there and no further. */
    onEscape?: () => void;
  };
  /** A reply: the subject is one more line of the head, not a heading. */
  reply?: boolean;
  /** While the letter sends nothing can be changed. */
  locked?: boolean;
  onType?: (line: string, value: string) => void;
  /** Enter or Tab on typed words: they become a person. */
  onCommit?: (line: string, value: string) => void;
  /**
   * A paste containing a separator, inserted into the typed text at the selection. The app makes each whole
   * address a person. A paste without a separator uses the browser's normal text edit.
   */
  onPaste?: (line: string, text: string) => void;
  onRemove?: (person: string) => void;
  /** A press without a move: the person's own menu. */
  onPerson?: (person: string, anchor: HTMLElement) => void;
  /** A person lands in `line`, as the `index`-th of the people already there. */
  onMove?: (person: string, to: Landing) => void;
  /** A drag starts: the app opens the lines that are not shown, so there is a place to land. */
  onLift?: () => void;
}

/**
 * Who a letter goes from and to. A person is moved along a line and between the lines: with the
 * pointer, under a finger after a long press, and with Alt and the arrows on the person itself.
 */
export function Recipients(props: RecipientsProps) {
  const { from, lines, folded, more, refusal, subject, reply, locked } = props;
  const { onType, onCommit, onRemove, onPerson, onMove } = props;
  const said = useId();
  const root = useRef<HTMLDivElement | null>(null);
  const keep = useRef<string | null>(null);
  const drag = useRecipientDrag(root, { locked, onMove, onLift: props.onLift });

  const whoOf = (id: string) => findIn(root.current, "person", id);
  const typeOf = (line: string) => findIn(root.current, "type", line);
  /* The keys stay on the person that moved. */
  useLayoutEffect(() => {
    if (!keep.current) return;
    whoOf(keep.current)?.focus({ preventScroll: true });
    keep.current = null;
  });

  const personKey = (e: KeyboardEvent<HTMLElement>, line: RecipientLine, at: number, l: number) =>
    personKeyOf(e, { lines, line, at, l }, { keep, onMove, onRemove, whoOf, typeOf });
  const typeKey = (e: KeyboardEvent<HTMLInputElement>, line: RecipientLine) =>
    typedKey(e, line, { onCommit, onRemove, whoOf });

  return (
    <div
      ref={root}
      className="oh-recipients"
      data-reply={reply ? "" : undefined}
      data-drag={drag.lifted ? "" : undefined}
      {...drag.root}
    >
      {from ? <FromLine from={from} /> : null}
      {folded ? (
        <FoldedLine folded={folded} />
      ) : (
        lines.map((line, l) => (
          <div
            key={line.id}
            className="oh-recipients-line"
            role="group"
            aria-label={line.label}
            data-line="people"
            data-line-id={line.id}
            data-over={drag.over?.line === line.id ? "" : undefined}
          >
            <b className="oh-recipients-label">{line.label}</b>
            <span className="oh-recipients-flow">
              {line.people.map((person, at) => (
                <RecipientChip
                  key={person.id}
                  person={person}
                  locked={locked}
                  said={refusal ? said : undefined}
                  lifted={drag.lifted?.id === person.id}
                  onPress={(anchor) => (drag.moved() ? undefined : onPerson?.(person.id, anchor))}
                  onRemove={() => {
                    onRemove?.(person.id);
                    typeOf(line.id)?.focus({ preventScroll: true });
                  }}
                  onKeyDown={(e) => personKey(e, line, at, l)}
                  onPointerDown={(e) => drag.press(e, person, line.id)}
                />
              ))}
              <RecipientType
                line={line}
                locked={locked}
                suggest={props.suggest}
                more={more && l === 0 && !locked ? more : undefined}
                onType={onType}
                onKeys={(e) => typeKey(e, line)}
                onPaste={props.onPaste}
              />
            </span>
          </div>
        ))
      )}
      {refusal && !folded ? (
        <p id={said} className="oh-text oh-recipients-refusal">
          <Icon name="warn" size={18} />
          <span>{refusal}</span>
        </p>
      ) : null}
      {subject ? <SubjectLine subject={subject} reply={reply} locked={locked} /> : null}
      {drag.lifted ? (
        <>
          {drag.caret ? <i className="oh-recipients-caret" style={drag.caret} aria-hidden="true" /> : null}
          <span className="oh-recipients-ghost" style={drag.ghost} aria-hidden="true">
            <RecipientChip person={drag.lifted} locked />
          </span>
        </>
      ) : null}
    </div>
  );
}

/** The element of this editor that carries `data-<attr>` with the value `id`. */
const findIn = (root: HTMLElement | null, attr: "person" | "type", id: string) =>
  [...(root?.querySelectorAll<HTMLElement>(`[data-${attr}]`) ?? [])].find((el) => el.dataset[attr] === id);

/**
 * Enter or Tab on typed words makes a person; Backspace on nothing takes the last one; Left goes to it. A modified
 * Enter or Tab is never a person's: Mod+Enter is Send's chord, and it reaches the keymap with the words as typed.
 */
function typedKey(
  e: KeyboardEvent<HTMLInputElement>,
  line: RecipientLine,
  to: Pick<RecipientsProps, "onCommit" | "onRemove"> & { whoOf: (id: string) => HTMLElement | undefined },
) {
  const last = line.people[line.people.length - 1];
  const input = e.currentTarget;
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
  if ((e.key === "Enter" || e.key === "Tab") && plain && input.value.trim()) {
    e.preventDefault();
    to.onCommit?.(line.id, input.value);
  } else if (e.key === "Backspace" && !input.value && last) {
    e.preventDefault();
    to.onRemove?.(last.id);
  } else if (e.key === "ArrowLeft" && !input.selectionStart && !input.selectionEnd && last) {
    e.preventDefault();
    to.whoOf(last.id)?.focus({ preventScroll: true });
  }
}

function FromLine({ from }: { from: NonNullable<RecipientsProps["from"]> }) {
  const own = useId();
  return (
    <div className="oh-recipients-line" data-line="from" data-long={from.long ? "" : undefined}>
      <b className="oh-recipients-label">{from.label}</b>
      {typeof from.value === "string" ? (
        <span className="oh-recipients-static">{from.value}</span>
      ) : (
        from.value
      )}
      {from.tag ? <Tag>{from.tag}</Tag> : null}
      {from.state ? (
        <span id={from.stateId ?? own} role="status" className="oh-recipients-state">
          {from.state}
        </span>
      ) : null}
      {from.stamp?.label ? (
        <span className="oh-recipients-stamp" title={from.stamp.hint}>
          {from.stamp.label}
        </span>
      ) : null}
      {from.stamp?.hint ? (
        <span className="oh-vh" role="status">
          {from.stamp.hint}
        </span>
      ) : null}
    </div>
  );
}

function FoldedLine({ folded }: { folded: NonNullable<RecipientsProps["folded"]> }) {
  return (
    <div className="oh-recipients-line" data-line="folded">
      <b className="oh-recipients-label">{folded.label}</b>
      <span className="oh-recipients-names">{folded.names}</span>
      <span className="oh-recipients-change">
        <Button kind="quiet" size="s" icon="user" label={folded.change.label} onPress={folded.change.onPress}>
          {folded.change.label}
        </Button>
      </span>
    </div>
  );
}

function SubjectLine({
  subject,
  reply,
  locked,
}: Required<Pick<RecipientsProps, "subject">> & Pick<RecipientsProps, "reply" | "locked">) {
  const Subject = reply ? "input" : "textarea";
  return (
    <div className="oh-recipients-line" data-line="subject">
      <Subject
        className="oh-control oh-display oh-recipients-subject"
        {...(reply ? { type: "text" } : { rows: 1, spellCheck: false })}
        aria-label={subject.label}
        placeholder={subject.placeholder}
        autoComplete="off"
        readOnly={locked}
        value={subject.value}
        onChange={(e) => subject.onChange?.(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || subject.onEscape === undefined || e.nativeEvent.isComposing) return;
          e.preventDefault();
          e.stopPropagation();
          subject.onEscape();
        }}
      />
    </div>
  );
}

/**
 * Alt and an arrow moves a person along its line or to the next line, and the keys stay on it;
 * Backspace or Delete takes it out; Left and Right walk the people and reach the typed words.
 */
function personKeyOf(
  e: KeyboardEvent<HTMLElement>,
  { lines, line, at, l }: { lines: readonly RecipientLine[]; line: RecipientLine; at: number; l: number },
  to: Pick<RecipientsProps, "onMove" | "onRemove"> & {
    keep: { current: string | null };
    whoOf: (id: string) => HTMLElement | undefined;
    typeOf: (line: string) => HTMLElement | undefined;
  },
) {
  const person = line.people[at]!;
  const move = (where: Landing) => {
    e.preventDefault();
    to.keep.current = person.id;
    to.onMove?.(person.id, where);
  };
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    const next = lines[l + (e.key === "ArrowUp" ? -1 : 1)];
    if (next) move({ line: next.id, index: next.people.length });
  } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    const index = at + (e.key === "ArrowLeft" ? -1 : 1);
    if (index >= 0 && index < line.people.length) move({ line: line.id, index });
  } else if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    to.onRemove?.(person.id);
    to.typeOf(line.id)?.focus({ preventScroll: true });
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const next = line.people[at + (e.key === "ArrowLeft" ? -1 : 1)];
    if (next) to.whoOf(next.id)?.focus({ preventScroll: true });
    else if (e.key === "ArrowRight") to.typeOf(line.id)?.focus({ preventScroll: true });
    else return;
    e.preventDefault();
  }
}
