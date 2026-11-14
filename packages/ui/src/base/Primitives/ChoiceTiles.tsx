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
}

/**
 * The tiles of a choice among names: second buttons of one width, as many in a row as the room has. A press takes
 * one at once. What is typed beside them narrows them by stepping the others back, never by taking them away.
 */
export function ChoiceTiles<V extends string>(props: ChoiceTilesProps<V>) {
  const { label, options, value, enter, onChange } = props;
  return (
    <div className="oh-choicetiles" role="group" aria-label={label}>
      <div className="oh-choicetiles-grid">
        {options.map((option) => (
          <span key={option.value} className="oh-choicetiles-tile" data-dim={option.dim ? "" : undefined}>
            <Button
              kind="two"
              size="l"
              pressed={option.value === value}
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
