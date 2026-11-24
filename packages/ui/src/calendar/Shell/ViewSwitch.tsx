import type { MouseEventHandler, Ref } from "react";
import { KeyHint } from "../../base/Primitives/KeyHint.js";
import "../../base/Primitives/seg.css";
import { Icon } from "../../icons/Icon.js";
import "./view-switch.css";

export interface ViewSwitchProps<V extends string> {
  /** The group's name: "View". The capsule reads it too, in a place that is no view. */
  label: string;
  /**
   * The views, each with the key that takes it where the app has one: the kit draws the hint for the eye (a
   * segment is named by its word alone), the app listens. `shortcut` is that key in `aria-keyshortcuts`' own
   * spelling ("2"): said to a screen reader on the segment, never drawn.
   */
  views: readonly { value: V; label: string; keyHint?: string; shortcut?: string }[];
  /** The view you are in; `null` in a place that is no view. */
  value: V | null;
  onChange?: (view: V) => void;
  /** No room for four segments: one capsule that names the view and opens the views' menu. */
  compact?: boolean;
  /** Whether the capsule's menu stands open. */
  menuOpen?: boolean;
  onOpen?: MouseEventHandler<HTMLButtonElement>;
  /** The capsule: its menu is placed by it. */
  capsuleRef?: Ref<HTMLButtonElement>;
}

/**
 * The views of the calendar in one control. The view you are in is the taken segment. Where the
 * head has no room it is one capsule with a chevron, and the app opens the views in a menu from it.
 */
export function ViewSwitch<V extends string>({
  label,
  views,
  value,
  onChange,
  compact,
  menuOpen,
  onOpen,
  capsuleRef,
}: ViewSwitchProps<V>) {
  if (compact) {
    const current = views.find((v) => v.value === value);
    /* The second button of the kit, with a chevron after its word. */
    return (
      <span className="oh-vs">
        <button
          ref={capsuleRef}
          type="button"
          className="oh-control oh-button oh-vs-cap"
          data-kind="two"
          data-size="s"
          aria-haspopup="menu"
          aria-expanded={menuOpen ?? false}
          onClick={onOpen}
        >
          <span>{current ? current.label : label}</span>
          <Icon name="down" size={16} className="oh-vs-way" />
        </button>
      </span>
    );
  }
  /* The segmented control's track, with a key in a segment: the base control's choices carry none. */
  return (
    <span className="oh-vs">
      <span className="oh-seg" role="group" aria-label={label} data-fit="wide">
        {views.map((view) => (
          <button
            key={view.value}
            type="button"
            className="oh-control oh-seg-item"
            aria-pressed={view.value === value}
            aria-keyshortcuts={view.shortcut}
            onClick={() => onChange?.(view.value)}
          >
            {view.label}
            {view.keyHint ? <KeyHint unsaid>{view.keyHint}</KeyHint> : null}
          </button>
        ))}
      </span>
    </span>
  );
}
