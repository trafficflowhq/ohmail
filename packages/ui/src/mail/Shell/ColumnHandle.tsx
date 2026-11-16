import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cssPoint } from "../../base/ui-zoom.js";
import "./column-handle.css";

export interface ColumnHandleProps {
  /** The column whose width it sets: it stands at that column's far edge. */
  column: "rail" | "list";
  /** Its name: "Sidebar width". */
  label: string;
  /** The column's width now, in px, and the widths it may have. */
  value: number;
  min: number;
  max: number;
  onChange?: (width: number) => void;
  /** A double press: back to the theme's own width. */
  onReset?: () => void;
}

/* What one key moves it. */
const STEP = 16;

/** A person's own width for a column. Nothing is drawn at rest. Desktop only. */
export function ColumnHandle({ column, label, value, min, max, onChange, onReset }: ColumnHandleProps) {
  const from = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const set = (width: number) => onChange?.(Math.max(min, Math.min(max, Math.round(width))));

  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = { ArrowLeft: value - STEP, ArrowRight: value + STEP, Home: min, End: max }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    set(to);
  };
  const down = (event: PointerEvent<HTMLDivElement>) => {
    from.current = { x: cssPoint(event).x, width: value };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (from.current) set(from.current.width + cssPoint(event).x - from.current.x);
  };
  const up = () => {
    from.current = null;
    setDragging(false);
  };

  return (
    <div
      className="oh-columnhandle"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      data-column={column}
      data-dragging={dragging ? "" : undefined}
      onKeyDown={key}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onReset}
    />
  );
}
