import { ActionPanel, type PanelVerb } from "../Reading/ActionPanel.js";

export interface SelectionBarProps {
  /** The toolbar's name. */
  label: string;
  /** How many rows are picked: the number, its word, and the two as the control's name. A press lets go of them. */
  count: { count: string; word: string; label: string; onClear?: () => void };
  /** The verbs over the picked rows, in the app's order. */
  verbs: readonly PanelVerb[];
  /** What stands behind the bar: Delete. */
  more?: { label: string; behind: boolean; expanded?: boolean; onPress?: () => void };
  keysShown?: boolean;
  /** How it stands before it has measured its room. */
  folded?: readonly string[];
  short?: readonly string[];
  onFold?: (ids: readonly string[]) => void;
}

/** The verbs over the rows you picked: the same panel as the reading column's, at the foot of the list. */
export function SelectionBar({
  label,
  count,
  verbs,
  more,
  keysShown,
  folded,
  short,
  onFold,
}: SelectionBarProps) {
  const clear: PanelVerb = {
    id: "clear",
    label: count.label,
    icon: "x",
    rank: 0,
    wordOrder: 1,
    wordFirst: true,
    counted: { count: count.count, word: count.word },
    onPress: count.onClear,
  };
  return (
    <ActionPanel
      label={label}
      items={[clear, ...verbs]}
      more={more}
      keysShown={keysShown}
      folded={folded}
      short={short}
      onFold={onFold}
    />
  );
}
