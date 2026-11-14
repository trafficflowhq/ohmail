import "./letter-columns.css";

export interface LetterColumnsProps {
  /** The lines as they were written, their spaces kept. */
  children: string;
  /** Its name for a screen reader, where it can be scrolled with the keys. */
  label?: string;
}

/** A block of a letter whose lines stand in columns: it keeps them and scrolls inside the letter. */
export function LetterColumns({ children, label }: LetterColumnsProps) {
  return (
    <pre
      className="oh-lettercolumns"
      role={label ? "region" : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      {children}
    </pre>
  );
}
