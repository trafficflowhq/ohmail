import { useId, type ReactNode } from "react";
import "./menu.css";

export interface MenuGroupProps {
  /** The group's title, drawn over its items as a menu's own title is: "Applies to". It names the group. */
  title: string;
  /** The group's items. */
  children: ReactNode;
}

/**
 * A titled group of a menu that holds more than one: its title over its items, and the group said by that title to
 * a screen reader as the keys enter it. A rule between two groups is a `MenuRule` of the menu itself.
 */
export function MenuGroup({ title, children }: MenuGroupProps) {
  const name = useId();
  return (
    <div role="group" aria-labelledby={name}>
      <h4 id={name} className="oh-text oh-menu-title">
        {title}
      </h4>
      {children}
    </div>
  );
}
