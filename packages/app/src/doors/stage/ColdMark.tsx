import type { ReactNode } from "react";
import { EndDot } from "@ohmail/ui/base";

/** The small "oh." a page opened cold carries where a way back would stand. A mark, said to nobody. */
export function ColdMark(): ReactNode {
  return (
    <span className="way-mark" aria-hidden="true">
      <EndDot kind="hot">oh</EndDot>
    </span>
  );
}
