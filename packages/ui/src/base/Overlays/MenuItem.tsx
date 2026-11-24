import type { ReactNode, Ref } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import { Dot } from "../Primitives/Dot.js";
import { KeyHint } from "../Primitives/KeyHint.js";
import { TagDot } from "../Primitives/TagDot.js";
import "./menu.css";

export interface MenuItemProps {
  /** The verb, or the choice. */
  children: string;
  label?: string;
  icon?: IconName;
  /** A person or a coloured mark alongside the choice. */
  leading?: ReactNode;
  /** A note at the right: when, how many. */
  note?: string;
  /** The key that runs it, as it is printed. */
  keyHint?: string;
  /** One of a few choices: whether this is the taken one. Left out: a verb. */
  checked?: boolean;
  /** Use the kit check icon for the current choice. */
  checkmark?: boolean;
  /** With `checked`: one of several that may all be taken (a tag), not one of a few. */
  many?: boolean;
  /** Switches in place; the leading mark alone shows the state. */
  stay?: boolean;
  disabled?: boolean;
  /** A tag of the person's own under a place: indented, with the tag's dot in this hue. */
  hue?: number;
  /** Led by the dot: hot when it wants you. Its words may then take two lines. */
  dot?: "hot" | "ink";
  ref?: Ref<HTMLButtonElement>;
  onPress?: () => void;
}

/** One line of a menu. */
export function MenuItem({
  children,
  label,
  icon,
  leading,
  note,
  keyHint,
  checked,
  checkmark,
  many,
  stay,
  disabled,
  hue,
  dot,
  ref,
  onPress,
}: MenuItemProps) {
  return (
    <button
      ref={ref}
      type="button"
      className="oh-control oh-menu-item"
      role={checked === undefined ? "menuitem" : many ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-sub={hue === undefined ? undefined : ""}
      data-dot={dot ? "" : undefined}
      data-checkmark={checkmark ? "" : undefined}
      data-stay={stay ? "" : undefined}
      onClick={onPress}
    >
      {checkmark ? <Icon name="check" size={20} /> : null}
      {icon ? <Icon name={icon} size={20} /> : null}
      {dot ? <Dot kind={dot} /> : null}
      {hue === undefined ? null : <TagDot hue={hue} />}
      {leading}
      <span className="oh-menu-word">{children}</span>
      {note ? <small className="oh-menu-item-note">{note}</small> : null}
      {keyHint ? <KeyHint unsaid>{keyHint}</KeyHint> : null}
    </button>
  );
}
