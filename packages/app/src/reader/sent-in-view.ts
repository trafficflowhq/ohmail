/**
 * THE REPLY YOU SENT, BROUGHT INTO VIEW in the reading column, as today's reader brings it (`sent-reveal.ts`): a send
 * pressed while the column's reply is open (whichever door pressed it: the shell's one send door notes the press)
 * arms it; once the reply has closed and the sent copy has joined the conversation at its foot, one eased scroll puts
 * the copy on screen. Nothing moves when the person scrolled since the press, past the window, or for a copy that is
 * not their own. What it answers: whether the visit's own reply has joined, for which the open's anchor stands down.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useMemo, type RefObject } from "react";
import { useSentReveal } from "@ohmail/app-logic/writing/sent-reveal";
import { scrollerOf } from "./read-dom.js";

export function useSentInView(o: {
  readonly openId: string;
  readonly messages: readonly EngineMessage[];
  /** The column's reply is open (its verbs stand in the panel). */
  readonly replying: boolean;
  /**
   * The column's root as the commit sets it: the letters (`data-conv-id`) are found under it, and its scrolling box
   * is what the reveal moves and where the person's own scroll is heard. Read live: a reveal carried into a column
   * just drawn arms in the effect of the render that drew it, before any state of that render names the root.
   */
  readonly column: RefObject<HTMLElement | null>;
}): () => boolean {
  const { column } = o;
  const scroller = useMemo(
    () => ({
      get current() {
        return scrollerOf(column.current);
      },
    }),
    [column],
  );
  return useSentReveal({
    visit: o.openId,
    members: o.messages,
    replying: o.replying,
    enabled: true,
    pane: () => column.current,
    scroller,
  }).claims;
}
