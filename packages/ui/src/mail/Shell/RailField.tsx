import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { tagDot } from "../../base/Primitives/hue.js";
import "./rail-entry.css";

export interface RailFieldProps {
  /** Its name for a screen reader: "New tag". It is not drawn; the placeholder says what to type. */
  label: string;
  /** What it asks for while it is empty: "Name a new tag…". */
  placeholder?: string;
  /** The dot before it: the hue the named tag will wear, on the ring, in degrees. */
  hue: number;
  /** Enter on a name: the name, without the space around it. What holds the field takes it away, or refuses. */
  onCommit: (name: string) => void;
  /** Escape, or Enter on nothing: nothing is named. */
  onCancel: () => void;
}

/**
 * A line of the rail a name is typed into, where the line that adds one stood ("New tag"). It takes the keys as
 * it appears and stands until what holds it takes it away: on a name, or on nothing.
 */
export function RailField({ label, placeholder, hue, onCommit, onCancel }: RailFieldProps) {
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => field.current?.focus({ preventScroll: true }), []);
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    /* Enter that ends a word being composed is the input method's. */
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      const name = event.currentTarget.value.trim();
      if (name) onCommit(name);
      else onCancel();
    } else if (event.key === "Escape") {
      /* It ends the naming and nothing else: what stands around the rail does not hear it. */
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
  };
  const style = { "--oh-railentry-dot": tagDot(hue) } as CSSProperties;
  return (
    <span className="oh-railfield" style={style}>
      <i className="oh-railentry-dot" />
      <input
        ref={field}
        type="text"
        className="oh-control oh-railfield-input"
        aria-label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={keys}
      />
    </span>
  );
}
