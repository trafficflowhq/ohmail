import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../../icons/Icon.js";
import "./selection-circle.css";

export interface CircleSelection {
  label: string;
  active: boolean;
  onPress: (extend: boolean) => void;
}

export function SelectionCircle({
  selection,
  picked = false,
  style,
  children,
}: {
  selection: CircleSelection;
  picked?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      className="oh-control oh-selection-circle"
      style={style}
      aria-label={selection.label}
      aria-pressed={picked}
      data-selection-active={selection.active ? "" : undefined}
      onClick={(event) => {
        event.stopPropagation();
        selection.onPress(event.shiftKey);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      {children}
    </button>
  );
}

export function SelectionMark() {
  return (
    <span className="oh-selection-circle-mark" aria-hidden="true">
      <Icon name="check" size={18} />
    </span>
  );
}
