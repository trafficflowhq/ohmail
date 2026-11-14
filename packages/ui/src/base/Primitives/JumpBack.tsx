import type { MouseEventHandler, Ref } from "react";
import { Icon } from "../../icons/Icon.js";
import "./button.css";
import "./jump-back.css";

export interface JumpBackProps {
  /** Where it takes you: "Back to top", "Latest message". */
  label: string;
  /** A list starts at its top; a conversation at its latest message, its end. */
  to: "top" | "end";
  /** It stands once the start is far away, and leaves when the column is back. */
  shown: boolean;
  /** What a pointer reads on it, where that says more than the name: the name with its key. */
  title?: string;
  /** A report stands at the same foot. */
  lifted?: boolean;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}

/** The way back to a column's start. The column that holds it is its frame: it stands at that foot's right corner. */
export function JumpBack({ label, to, shown, title, lifted, onPress, ref }: JumpBackProps) {
  return (
    <button
      ref={ref}
      type="button"
      className="oh-control oh-button oh-jumpback"
      data-kind="two"
      data-bare=""
      data-on={shown ? "" : undefined}
      data-lifted={lifted ? "" : undefined}
      aria-label={label}
      title={title ?? label}
      aria-hidden={shown ? undefined : true}
      tabIndex={shown ? undefined : -1}
      onClick={onPress}
    >
      <Icon name={to === "end" ? "godown" : "goup"} size={20} />
    </button>
  );
}
