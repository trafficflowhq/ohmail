import type { FormEvent, ReactNode } from "react";
import "./form.css";

/**
 * A door's step that takes blanks: one form, so Enter in a blank presses its ink button; it lays out nothing of its
 * own. The press is the door's act; the browser's own submit never leaves the page. Until the page's script has taken
 * the form, a press IS the browser's own, and it sends every NAMED blank as the page's query: so no blank of a door
 * carries a `name` (the old cards' carried none), and a press before the script sends nothing that was typed. A
 * password manager finds a blank by its type, its id and what it may be filled with.
 */
export function DoorForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }): ReactNode {
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onSubmit();
  };
  return (
    <form className="way-door-form" onSubmit={submit}>
      {children}
    </form>
  );
}

/** A step's blanks, one under the other; `under` where they follow the page's sentence in its own column. */
export function DoorFields({ children, under }: { children: ReactNode; under?: boolean }): ReactNode {
  return (
    <div className="way-door-fields" data-under={under ? "" : undefined}>
      {children}
    </div>
  );
}
