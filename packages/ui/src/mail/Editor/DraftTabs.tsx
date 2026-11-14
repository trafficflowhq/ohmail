import { Seg, type SegOption } from "../../base/index.js";
import "./draft-control.css";

export interface DraftTabsProps<V extends string> {
  /** The pair's name for a screen reader. */
  label: string;
  /** The two texts: the person's own, and the draft. */
  options: readonly [SegOption<V>, SegOption<V>];
  value: V;
  onChange?: (value: V) => void;
}

/** The two texts once a draft has landed, as tabs over the text they switch. Send sends the one that is pressed. */
export function DraftTabs<V extends string>({ label, options, value, onChange }: DraftTabsProps<V>) {
  return (
    <div className="oh-drafttabs">
      <Seg label={label} options={options} value={value} onChange={onChange} fit="wide" />
    </div>
  );
}
