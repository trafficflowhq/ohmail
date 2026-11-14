import { useRef, type KeyboardEvent } from "react";
import "./radio-lines.css";
import { Tag } from "./Tag.js";

export interface RadioLine<V extends string> {
  value: V;
  label: string;
  /** What this answer is about, in words: "12 messages". */
  note?: string;
  /** A word after its name: "Your plan". */
  tag?: string;
  /** A figure that ends its line: a plan's price. */
  figure?: string;
}

export interface RadioLinesProps<V extends string> {
  /** The question, said to a screen reader. */
  label: string;
  options: readonly RadioLine<V>[];
  value: V;
  onChange?: (value: V) => void;
  /**
   * `sheet`: on a sheet of settings each answer is one of the sheet's lines (a plan among the plans): its mark,
   * its name and tag, what it is about beside them and its figure at the line's end; under a finger what it is
   * about goes under the name. Left out: a line each, with what it is about under it.
   */
  kind?: "sheet";
}

/** Two answers with consequences. The choice takes effect at once; the arrows move it. */
export function RadioLines<V extends string>({ label, options, value, onChange, kind }: RadioLinesProps<V>) {
  const group = useRef<HTMLDivElement | null>(null);
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : null;
    if (!step && edge === null) return;
    e.preventDefault();
    const at = Math.max(
      0,
      options.findIndex((o) => o.value === value),
    );
    const to = edge ?? (at + step + options.length) % options.length;
    onChange?.(options[to]!.value);
    group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };
  const taken = options.some((o) => o.value === value);
  return (
    <div
      ref={group}
      className="oh-radiolines"
      role="radiogroup"
      aria-label={label}
      data-kind={kind}
      onKeyDown={move}
    >
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className="oh-control oh-radioline"
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!taken && i === 0) ? 0 : -1}
            onClick={() => onChange?.(option.value)}
          >
            {kind === "sheet" ? <i className="oh-radioline-mark" aria-hidden="true" /> : null}
            <span className="oh-radioline-word">
              {option.label}
              {option.tag ? <Tag>{option.tag}</Tag> : null}
            </span>
            {option.note ? <small className="oh-radioline-note">{option.note}</small> : null}
            {option.figure ? <b className="oh-radioline-figure">{option.figure}</b> : null}
          </button>
        );
      })}
    </div>
  );
}
