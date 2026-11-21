import type { ReactNode } from "react";
import "./code-text.css";

/** Text copied or compared exactly, with wrapping for a long value. */
export function CodeText({ children }: { children: ReactNode }) {
  return <code className="oh-text oh-code-text">{children}</code>;
}

/** The scanner's tile, with room for the code's quiet zone. */
export function CodeTile({ children }: { children: ReactNode }) {
  return <div className="oh-code-tile">{children}</div>;
}
