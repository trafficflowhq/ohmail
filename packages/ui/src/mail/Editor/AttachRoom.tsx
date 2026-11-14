import type { ReactNode } from "react";
import "./attach.css";

export interface AttachRoomProps {
  /** How the pictures go, as a sentence with its slot: the control for their quality. */
  children?: ReactNode;
  /** What the choice does to their weight: "7.3 → 2.1 MB". */
  weight?: string;
  /** How much of a message's room is used: "2.1 of 19.1 MB". */
  used: string;
}

/** Under the sheet, from the first file on: the quality the pictures go at, and how much of the room is used. */
export function AttachRoom({ children, weight, used }: AttachRoomProps) {
  return (
    <p className="oh-text oh-attachroom">
      {children ? <span>{children}</span> : null}
      {weight ? <span className="oh-attachroom-weight">{weight}</span> : null}
      <span className="oh-attachroom-used">{used}</span>
    </p>
  );
}
