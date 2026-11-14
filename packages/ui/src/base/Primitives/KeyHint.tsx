import "./key-hint.css";

export interface KeyHintProps {
  /** The key as it is printed: the app names it, with the platform's own modifier. */
  children: string;
  /** Shown whatever the face says: where key hints are switched on, and in a context menu. Never on touch. */
  shown?: boolean;
  /** Drawn for the eye alone: on a control named by its words, so that the key is never said as part of that name. */
  unsaid?: boolean;
}

/** The key that runs a verb, on its control. The kit draws the hint; the app's key registry listens. */
export function KeyHint({ children, shown, unsaid }: KeyHintProps) {
  return (
    <kbd className="oh-key" data-shown={shown ? "" : undefined} aria-hidden={unsaid ? true : undefined}>
      {children}
    </kbd>
  );
}
