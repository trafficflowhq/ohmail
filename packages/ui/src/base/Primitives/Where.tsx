import "./tag.css";

/** A place, as a word: where a row of a list is. */
export function Where({ children }: { children: string }) {
  return <span className="oh-where">{children}</span>;
}
