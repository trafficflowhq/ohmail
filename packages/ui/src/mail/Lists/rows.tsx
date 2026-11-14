import type { ReactNode } from "react";

/**
 * The rows of one group: the list they stand in, set in from the sheet's edge. Named, it is a listbox of options
 * (`Row.listing`), many-selectable when picks are made in it. A group can also stand inside a shared listbox.
 */
export function Rows({
  children,
  label,
  listLabel,
  many,
  group,
}: {
  children: ReactNode;
  label?: string;
  /** Names a list whose rows are list items. */
  listLabel?: string;
  many?: boolean;
  group?: boolean;
}) {
  return (
    <div
      className="oh-rows"
      role={group ? "group" : label ? "listbox" : "list"}
      aria-label={label ?? listLabel}
      aria-multiselectable={!group && label && many ? true : undefined}
    >
      {children}
    </div>
  );
}
