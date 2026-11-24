import { useRef } from "react";
import { Icon } from "../../icons/Icon.js";
import { Menu } from "../Overlays/Menu.js";
import { MenuItem } from "../Overlays/MenuItem.js";
import { Dot } from "../Primitives/Dot.js";
import { Notice, type NoticeProps } from "./Notice.js";
import "./notice-slot.css";

export interface SlotNotice extends Omit<NoticeProps, "place"> {
  id: string;
  /** Its place in the fixed order: the lower, the further in front. */
  rank: number;
}

export interface NoticeSlotProps {
  /** Where the slot is: the rail's foot, or the bar over a list. */
  place: NoticeProps["place"];
  /** Everything that is true at once, in any order. */
  notices: readonly SlotNotice[];
  /** The one a press brought to the front. Once it is gone, the order stands again. */
  front?: string;
  onFront: (id: string) => void;
  /** The line behind which the others stand, for their number: what it shows and what it is called. */
  more: { label: string; name: string; collapse?: string };
  /** Whether the others are listed, and the press that lists or hides them. */
  open: boolean;
  onOpen: (open: boolean) => void;
}

/** The slot's order: by rank, then as they came; the one brought to the front first. */
export function slotOrder(notices: readonly SlotNotice[], front?: string): SlotNotice[] {
  const sorted = notices.map((n, i) => ({ n, i })).sort((a, b) => a.n.rank - b.n.rank || a.i - b.i);
  const list = sorted.map((x) => x.n);
  const at = list.findIndex((n) => n.id === front);
  if (at > 0) list.unshift(...list.splice(at, 1));
  return list;
}

/**
 * Everything that is true at once, in one slot: the first in full, the rest behind one line that
 * lists them. Mail is never pushed down by more than one notice and that line. The first stands at one
 * place whether others stand behind it or not, so a notice already said is never drawn, and said, again.
 */
export function NoticeSlot({ place, notices, front, onFront, more, open, onOpen }: NoticeSlotProps) {
  const line = useRef<HTMLButtonElement | null>(null);
  const [first, ...rest] = slotOrder(notices, front);
  if (!first) return null;
  return (
    <div className="oh-noticeslot" data-alone={rest.length ? undefined : ""}>
      <Notice key={first.id} {...first} place={place} />
      {rest.length ? (
        <>
          <button
            ref={line}
            type="button"
            className="oh-control oh-button oh-noticeslot-more"
            data-kind="quiet"
            data-size="s"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={more.name}
            onClick={() => onOpen(!open)}
          >
            <Dot kind={rest.some((n) => n.hot) ? "hot" : "ink"} />
            <span>{more.label}</span>
            <Icon name="down" size={16} />
          </button>
          <Menu open={open} onClose={() => onOpen(false)} anchor={line} label={more.name}>
            {rest.map((n) => (
              <MenuItem
                key={n.id}
                dot={n.hot ? "hot" : "ink"}
                onPress={() => {
                  onFront(n.id);
                  onOpen(false);
                }}
              >
                {n.title}
              </MenuItem>
            ))}
            {more.collapse ? <MenuItem onPress={() => onOpen(false)}>{more.collapse}</MenuItem> : null}
          </Menu>
        </>
      ) : null}
    </div>
  );
}
