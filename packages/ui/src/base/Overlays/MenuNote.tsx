import "./menu.css";

/** One quiet line in a menu that is no item. */
export function MenuNote({ children }: { children: string }) {
  return <p className="oh-text oh-menu-note">{children}</p>;
}
