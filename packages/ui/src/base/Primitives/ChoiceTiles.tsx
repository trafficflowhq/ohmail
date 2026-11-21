import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Button } from "./Button.js";
import "./choice-tiles.css";

export interface ChoiceTile<V extends string> {
  value: V;
  label: string;
  /** It does not fit what was typed beside the tiles: it steps back, and can still be pressed. */
  dim?: boolean;
}

export interface ChoiceTilesProps<V extends string> {
  /** The group's name, said to a screen reader: "Mail providers". */
  label: string;
  /** A dozen or so answers that are names: each a tile of one word or two. */
  options: readonly ChoiceTile<V>[];
  /** The one that is taken, held. `null` or left out: none is. */
  value?: V | null;
  /** The one Enter takes, with the key printed on it. The app listens for the key; the kit draws the hint. */
  enter?: { value: V; keyHint: string };
  onChange?: (value: V) => void;
  compact?: boolean;
}

/**
 * The tiles of a choice among names: second buttons of one width, as many in a row as the room has. A press takes
 * one at once. What is typed beside them narrows them by stepping the others back, never by taking them away.
 * The group is one stop of Tab, on the taken tile or else the first; the arrows, Home and End move the keys between
 * the tiles and take none.
 */
export function ChoiceTiles<V extends string>(props: ChoiceTilesProps<V>) {
  const { label, options, value, enter, onChange, compact } = props;
  const group = useRef<HTMLDivElement | null>(null);
  /* The tile the keys are on while they are in the group: Tab leaves the group from there. */
  const [on, setOn] = useState<number | null>(null);
  const stop =
    on ??
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
  const tiles = () => [...(group.current?.querySelectorAll<HTMLElement>("button") ?? [])];
  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? options.length - 1 : null;
    if (!step && edge === null) return;
    e.preventDefault();
    tiles()[edge ?? (stop + step + options.length) % options.length]?.focus();
  };
  const entered = (e: FocusEvent<HTMLDivElement>) => {
    const at = tiles().indexOf(e.target);
    if (at >= 0) setOn(at);
  };
  const left = (e: FocusEvent<HTMLDivElement>) => {
    if (!group.current?.contains(e.relatedTarget)) setOn(null);
  };
  return (
    <div
      ref={group}
      className="oh-choicetiles"
      role="group"
      aria-label={label}
      onKeyDown={move}
      onFocus={entered}
      onBlur={left}
    >
      <div className="oh-choicetiles-grid" data-compact={compact ? "" : undefined}>
        {options.map((option, i) => (
          <span key={option.value} className="oh-choicetiles-tile" data-dim={option.dim ? "" : undefined}>
            <Button
              kind="two"
              size="l"
              pressed={option.value === value}
              stop={i === stop}
              keyHint={enter?.value === option.value ? enter.keyHint : undefined}
              onPress={() => onChange?.(option.value)}
            >
              {option.label}
            </Button>
          </span>
        ))}
      </div>
    </div>
  );
}
