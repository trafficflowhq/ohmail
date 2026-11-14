/**
 * THE STREAM'S KEYS while its pane has the keyboard: `j` or ↓ opens the next item and `k` or ↑ the previous one, from
 * the one open or else the one under the reading line. A key is no hand on the stream: the step drives it, and only
 * the rest reads what it comes to. Never in a field, never with a modifier.
 */
import { useEffect, useRef } from "react";
import { isTypingTarget } from "@ohmail/app-logic/keys";
import type { StreamModel } from "@ohmail/app-logic/streams";

/** The keys that step the stream, and which way. */
const STEPS: ReadonlyMap<string, 1 | -1> = new Map([
  ["j", 1],
  ["ArrowDown", 1],
  ["k", -1],
  ["ArrowUp", -1],
]);

/** The item a step goes to: the next or the previous one of the stream, from the open one or the current one. */
export function stepOf(model: StreamModel, by: 1 | -1): string | null {
  const from = model.openId ?? model.current;
  const at = from === null ? -1 : model.items.findIndex((m) => m.id === from);
  if (at < 0) return by === 1 ? (model.items[0]?.id ?? null) : null;
  return model.items[at + by]?.id ?? null;
}

export function useStreamKeys(on: boolean, root: Element | null, model: StreamModel): void {
  const latest = useRef(model);
  latest.current = model;
  useEffect(() => {
    const win = root?.ownerDocument.defaultView;
    if (!on || !win) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const by = STEPS.get(e.key);
      if (by === undefined) return;
      const to = stepOf(latest.current, by);
      if (to === null) return;
      e.preventDefault();
      latest.current.open(to);
    };
    win.addEventListener("keydown", onKey);
    return () => win.removeEventListener("keydown", onKey);
  }, [on, root]);
}
