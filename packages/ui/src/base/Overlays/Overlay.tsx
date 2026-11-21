import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { closeTopmost, useOverlayEscape } from "./overlay-escape.js";
import { cycleTab, useOverlayFocus } from "./overlay-focus.js";
import "./overlay.css";

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  /** Its name, said to a screen reader: the words, or the id of the node that holds them. */
  label?: string;
  labelledBy?: string;
  /** The id of the part that explains the decision. */
  describedBy?: string;
  role?: "dialog" | "alertdialog";
  /** The part that stands on the scrim: its own class draws it. */
  className: string;
  /** Fade the scrim with the panel, or just its backdrop. Omitted: the backdrop is steady. */
  scrimMotion?: "together" | "backdrop";
  /** Where it stands: in the middle, or under the window's top. */
  place?: "top";
  /** What takes the keys as it opens. Left out: its first button. */
  first?: (box: HTMLElement) => HTMLElement | null | undefined;
  /** The part's own keys, asked before Esc and Tab. True: the key was taken. */
  onKey?: (e: KeyboardEvent<HTMLDivElement>) => boolean;
  children: ReactNode;
}

const firstButton = (box: HTMLElement) => box.querySelector<HTMLElement>("button:not(:disabled)");

/**
 * The frame of everything that stands over the whole window: a scrim, and one modal part on it. The
 * keys land in the part and stay inside; Esc (wherever the keys are, the topmost first) and a press on
 * the scrim close it, and the keys go back to what opened it. A key pressed over it is never the window's
 * underneath.
 */
export function Overlay({
  open,
  onClose,
  label,
  labelledBy,
  describedBy,
  role = "dialog",
  className,
  scrimMotion,
  place,
  first,
  onKey,
  children,
}: OverlayProps) {
  const box = useRef<HTMLDivElement | null>(null);
  useOverlayFocus(open, box, first ?? firstButton);
  useOverlayEscape(open, box, onClose);
  if (!open) return null;

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (onKey?.(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeTopmost();
    } else cycleTab(e, e.currentTarget);
  };

  return (
    <div className="oh-over">
      <div
        className="oh-scrim"
        data-scrim=""
        data-scrim-motion={scrimMotion}
        data-place={place}
        onPointerDown={(e) => (e.target === e.currentTarget ? onClose() : undefined)}
      >
        <div
          ref={box}
          className={`oh-overlay ${className}`}
          role={role}
          aria-modal="true"
          aria-label={label}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          tabIndex={-1}
          onKeyDown={keys}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
