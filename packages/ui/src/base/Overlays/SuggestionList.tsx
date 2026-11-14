import { useLayoutEffect, useRef, type MouseEventHandler, type ReactNode } from "react";
import { animate } from "../../motion/motion.js";
import { Tag } from "../Primitives/Tag.js";
import "./suggestion-list.css";
import { markTyped } from "./suggestion-mark.js";
import { useAtField, type FieldPlace } from "./suggestion-place.js";

/** One thing a field offers. */
export interface SuggestionRow {
  /** Its own name among the rows of one list. */
  id: string;
  /** What leads it: a person's circle, the icon of its kind. */
  mark?: ReactNode;
  /** Its first line, and the second under it. The typed part of each is drawn bold by the list. */
  primary: string;
  secondary?: string;
  /** A word at the row's end: "wrote to you". */
  tag?: string;
  /** Its whole words, where a line may be cut. */
  title?: string;
}

/** Rows that belong together. One with a head stands under it; a rule stands between two groups. */
export interface SuggestionGroup<R extends SuggestionRow = SuggestionRow> {
  head?: string;
  rows: readonly R[];
}

/** How a row was taken. */
export type SuggestionVia = "press" | "enter" | "tab";

export interface SuggestionListProps<R extends SuggestionRow = SuggestionRow> extends Partial<FieldPlace> {
  /** The listbox's id: its field names it, and row `n` is `<id>-<n>`, counted over all groups. */
  id: string;
  /** Its name, said to a screen reader: "Place suggestions". */
  label: string;
  groups: readonly SuggestionGroup<R>[];
  /** What was typed: its part of each line is drawn bold. */
  query: string;
  /** The row the keys are on, counted over all groups. `null`: none, the typed text stands. */
  active: number | null;
  /** A pointer moved the keys' row. */
  onActive?: (index: number) => void;
  /** A row was pressed. */
  onTake?: (row: R, via: SuggestionVia) => void;
  /** Answers are on their way: one line runs along the top once, over the rows that stand. */
  busy?: boolean;
  /** What stands at the foot, outside the rows, and stays while they scroll: a source's credit. */
  foot?: ReactNode;
  /**
   * `anchored` (left out): a card of its own, wearing a menu's surface. With `anchor` it stands in a layer of
   * its own at its field; without, where it is put, as wide as what holds it. `inline`: the rows alone, set
   * into a sheet.
   */
  placement?: "anchored" | "inline";
}

/** The id of row `index` of the list `id`: what the field names as the row the keys are on. */
export const suggestionId = (id: string, index: number): string => `${id}-${index}`;

/* A press on the list never takes the caret out of its field. */
const keepCaret: MouseEventHandler = (event) => event.preventDefault();

/**
 * What a field offers while a person types: a listbox the keys walk from the field and a press takes from. With
 * nothing to offer it is not there. It is told its rows and words, and knows nothing of what they stand for.
 */
export function SuggestionList<R extends SuggestionRow = SuggestionRow>(props: SuggestionListProps<R>) {
  const { id, label, query, active, onActive, onTake, busy, foot, placement, anchor, boundary, align } =
    props;
  const groups = props.groups.filter((group) => group.rows.length);
  const card = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const shown = groups.length > 0;
  const inline = placement === "inline";
  const atField = !inline && anchor !== undefined ? { anchor, boundary, align } : null;

  useAtField(card, atField);
  /* It arrives once, when it opens. Rows that change do not arrive again. */
  useLayoutEffect(() => {
    if (shown && !inline && card.current) animate(card.current, "pop", { ease: "--e-pop" });
  }, [shown, inline]);
  /* The row the keys are on is in sight. */
  useLayoutEffect(() => {
    const box = list.current;
    const row = active === null ? null : box?.querySelector<HTMLElement>("[aria-selected='true']");
    if (!box || !row) return;
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [active]);
  if (!shown) return null;

  let index = 0;
  const drawn = (
    <div
      ref={card}
      className="oh-suggest"
      data-inline={inline ? "" : undefined}
      data-busy={busy ? "" : undefined}
      onMouseDown={keepCaret}
    >
      <div
        ref={list}
        id={id}
        className="oh-suggest-list"
        role="listbox"
        aria-label={label}
        aria-busy={busy || undefined}
      >
        {groups.map((group, g) => (
          <div key={group.head ?? g} className="oh-suggest-group" role="group" aria-label={group.head}>
            {group.head ? (
              <div className="oh-suggest-head" aria-hidden="true">
                {group.head}
              </div>
            ) : null}
            {group.rows.map((row) => {
              const n = index++;
              return (
                <Row
                  key={row.id}
                  id={suggestionId(id, n)}
                  row={row}
                  query={query}
                  on={n === active}
                  onOver={() => onActive?.(n)}
                  onPress={() => onTake?.(row, "press")}
                />
              );
            })}
          </div>
        ))}
      </div>
      {foot ? <div className="oh-suggest-foot">{foot}</div> : null}
    </div>
  );
  return atField ? <div className="oh-suggest-layer">{drawn}</div> : drawn;
}

/** One row: the mark of its kind, its first line and its second, a tag at its end. Pressed like a button, and never a stop of the keys: they stay in the field. */
function Row(props: {
  id: string;
  row: SuggestionRow;
  query: string;
  on: boolean;
  onOver: () => void;
  onPress: () => void;
}) {
  const { id, row, query, on, onOver, onPress } = props;
  return (
    <button
      type="button"
      id={id}
      className="oh-control oh-suggest-row"
      role="option"
      tabIndex={-1}
      aria-selected={on}
      title={row.title}
      onPointerMove={(event) => {
        /* The pointer and the keys share one row. A finger moves nothing: it scrolls. */
        if (event.pointerType !== "touch" && !on) onOver();
      }}
      onClick={onPress}
    >
      <span className="oh-suggest-mark">{row.mark}</span>
      <span className="oh-suggest-words" data-words="">
        {/* Each line is text of its own direction: a name in another script reorders nothing beside it. */}
        <span className="oh-suggest-first" dir="auto">
          <Typed text={row.primary} typed={query} />
        </span>
        {row.secondary ? (
          <span className="oh-suggest-second" dir="auto">
            <Typed text={row.secondary} typed={query} />
          </span>
        ) : null}
      </span>
      {row.tag ? <Tag>{row.tag}</Tag> : null}
    </button>
  );
}

/** A line with the part a person typed drawn bold. */
function Typed({ text, typed }: { text: string; typed: string }) {
  return markTyped(text, typed).map((part, i) =>
    part.typed ? (
      <b key={i} className="oh-suggest-typed">
        {part.text}
      </b>
    ) : (
      part.text
    ),
  );
}

export interface SuggestionCreditProps {
  /** The credit's words: whose answers the rows are. */
  children: string;
  /** Where it leads. With an address it is a link; without, a button that runs `onPress`. */
  href?: string;
  /** Where a press leads, said before the press. */
  title?: string;
  onPress?: MouseEventHandler<HTMLElement>;
}

/** A source's credit at a suggestion list's foot: quiet words that lead to the source. Tab never stops on it: the caret stays in the field. */
export function SuggestionCredit({ children, href, title, onPress }: SuggestionCreditProps) {
  const look = { className: "oh-control oh-suggest-credit", title, tabIndex: -1, onClick: onPress } as const;
  return href === undefined ? (
    <button type="button" {...look}>
      {children}
    </button>
  ) : (
    <a href={href} target="_blank" rel="noreferrer" {...look}>
      {children}
    </a>
  );
}
