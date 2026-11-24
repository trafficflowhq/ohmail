import type { ChangeEvent, ReactNode } from "react";
import type { EventFormItem } from "./EventForm.js";

export function eventField(
  it: Extract<EventFormItem, { kind: "time" | "text" | "notes" }>,
  key: number,
): ReactNode {
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
