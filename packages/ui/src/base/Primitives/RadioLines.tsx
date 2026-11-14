import { useRef, type KeyboardEvent } from "react";
import "./radio-lines.css";

export interface RadioLine<V extends string> {
  value: V;
  label: string;
  /** What this answer is about, in words: "12 messages". */
  note?: string;
}

export interface RadioLinesProps<V extends string> {
  /** The question, said to a screen reader. */
  label: string;
  options: readonly RadioLine<V>[];
  value: V;
  onChange?: (value: V) => void;
}

/** Two answers with consequences. The choice takes effect at once; the arrows move it. */
export function RadioLines<V extends string>({ label, options, value, onChange }: RadioLinesProps<V>) {
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
    <div ref={group} className="oh-radiolines" role="radiogroup" aria-label={label} onKeyDown={move}>
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
            <span className="oh-radioline-word">{option.label}</span>
            {option.note ? <small className="oh-radioline-note">{option.note}</small> : null}
          </button>
        );
      })}
    </div>
  );
}
