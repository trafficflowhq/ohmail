import type { ReactNode } from "react";

/**
 * The rows of one group: the list they stand in, set in from the sheet's edge. Named, it is a listbox of options
 * (`Row.listing`), many-selectable when picks are made in it.
 */
export function Rows({ children, label, many }: { children: ReactNode; label?: string; many?: boolean }) {
  return (
    <div
      className="oh-rows"
      role={label ? "listbox" : "list"}
      aria-label={label}
      aria-multiselectable={label && many ? true : undefined}
    >
      {children}
    </div>
  );
}
