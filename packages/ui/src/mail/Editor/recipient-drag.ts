import { useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import type { RecipientPerson } from "./RecipientChip.js";

/** Where a person lands: the line, and its place among the people already there. */
export interface Landing {
  line: string;
  index: number;
}

interface Press {
  person: RecipientPerson;
  line: string;
  pointer: number;
  x: number;
  y: number;
  /** Where in the person the pointer took hold. */
  dx: number;
  dy: number;
  finger: boolean;
  wait?: ReturnType<typeof setTimeout>;
}

interface Held {
  lifted: RecipientPerson;
  from: string;
  over: Landing | null;
  ghost: CSSProperties;
  caret: CSSProperties | null;
}

/** A pointer lifts a person once it has moved this far; a finger after it has rested this long. */
const FAR = 4;
const LONG_PRESS = 380;

const peopleOf = (line: Element, lifted: string): HTMLElement[] =>
  [...line.querySelectorAll<HTMLElement>("[data-person]")].filter((el) => el.dataset.person !== lifted);

/**
 * A person dragged along its line and between the lines. Every line is a place to land; let go on a
 * line, the person lands where the caret stood. Esc, or letting go away from the lines, puts it back.
 */
export function useRecipientDrag(
  root: RefObject<HTMLElement | null>,
  how: { locked?: boolean; onMove?: (person: string, to: Landing) => void; onLift?: () => void },
) {
  const [held, setHeld] = useState<Held | null>(null);
  const press = useRef<Press | null>(null);
  const dragged = useRef(false);

  const find = (x: number, y: number, lifted: string): Pick<Held, "over" | "caret"> => {
    const box = root.current;
    if (!box) return { over: null, caret: null };
    const home = box.getBoundingClientRect();
    for (const line of box.querySelectorAll<HTMLElement>("[data-line-id]")) {
      const r = line.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const people = peopleOf(line, lifted).map((el) => el.parentElement!.getBoundingClientRect());
      const index = people.filter((p) => p.bottom < y || (p.top <= y && p.left + p.width / 2 < x)).length;
      const at = people[index];
      const last = people[people.length - 1];
      const flow = line.querySelector("[data-type]")?.getBoundingClientRect() ?? r;
      const stand = at
        ? { left: at.left, top: at.top, height: at.height }
        : last
          ? { left: last.right, top: last.top, height: last.height }
          : { left: flow.left, top: flow.top, height: flow.height };
      return {
        over: { line: line.dataset.lineId!, index },
        caret: { left: stand.left - home.left, top: stand.top - home.top, height: stand.height },
      };
    }
    return { over: null, caret: null };
  };

  const lift = (p: Press, x: number, y: number) => {
    dragged.current = true;
    root.current?.setPointerCapture?.(p.pointer);
    how.onLift?.();
    setHeld({
      lifted: p.person,
      from: p.line,
      ghost: { transform: `translate(${x - p.dx}px, ${y - p.dy}px)` },
      ...find(x, y, p.person.id),
    });
  };
  const end = () => {
    const p = press.current;
    if (p?.wait) clearTimeout(p.wait);
    if (p) root.current?.releasePointerCapture?.(p.pointer);
    press.current = null;
    setHeld(null);
    /* The press that ends a drag is read as no press on the person; nothing later is. */
    setTimeout(() => {
      dragged.current = false;
    }, 0);
  };

  return {
    lifted: held?.lifted ?? null,
    over: held?.over ?? null,
    caret: held?.caret ?? null,
    ghost: held?.ghost,
    /** True once, straight after a drag: the press that ends it is not a press on the person. */
    moved: (): boolean => {
      const was = dragged.current;
      dragged.current = false;
      return was;
    },
    press: (e: PointerEvent<HTMLElement>, person: RecipientPerson, line: string) => {
      if (how.locked || e.button !== 0) return;
      dragged.current = false;
      const r = e.currentTarget.getBoundingClientRect();
      const p: Press = {
        person,
        line,
        pointer: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        dx: e.clientX - r.left,
        dy: e.clientY - r.top,
        finger: e.pointerType === "touch",
      };
      /* Under a finger a long press lifts the person; a finger that moves first scrolls. */
      if (p.finger) p.wait = setTimeout(() => lift(p, p.x, p.y), LONG_PRESS);
      press.current = p;
    },
    root: {
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const p = press.current;
        if (!p || e.pointerId !== p.pointer) return;
        if (!held) {
          const far = Math.hypot(e.clientX - p.x, e.clientY - p.y) > FAR;
          if (p.finger) {
            if (far) end();
          } else if (far) lift(p, e.clientX, e.clientY);
          return;
        }
        setHeld({
          ...held,
          ghost: { transform: `translate(${e.clientX - p.dx}px, ${e.clientY - p.dy}px)` },
          ...find(e.clientX, e.clientY, p.person.id),
        });
      },
      onPointerUp: (e: PointerEvent<HTMLElement>) => {
        const p = press.current;
        if (!p || e.pointerId !== p.pointer) return;
        if (held?.over) how.onMove?.(p.person.id, held.over);
        end();
      },
      onPointerCancel: end,
      onKeyDown: (e: { key: string; preventDefault: () => void }) => {
        if (held && e.key === "Escape") {
          e.preventDefault();
          end();
        }
      },
    },
  };
}
