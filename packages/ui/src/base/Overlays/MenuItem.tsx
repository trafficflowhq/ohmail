import { Icon, type IconName } from "../../icons/Icon.js";
import { Dot } from "../Primitives/Dot.js";
import { KeyHint } from "../Primitives/KeyHint.js";
import { TagDot } from "../Primitives/TagDot.js";
import "./menu.css";

export interface MenuItemProps {
  /** The verb, or the choice. */
  children: string;
  icon?: IconName;
  /** A note at the right: when, how many. */
  note?: string;
  /** The key that runs it, as it is printed. */
  keyHint?: string;
  /** One of a few choices: whether this is the taken one. Left out: a verb. */
  checked?: boolean;
  /** With `checked`: one of several that may all be taken (a tag), not one of a few. */
  many?: boolean;
  disabled?: boolean;
  /** A tag of the person's own under a place: indented, with the tag's dot in this hue. */
  hue?: number;
  /** Led by the dot: hot when it wants you. Its words may then take two lines. */
  dot?: "hot" | "ink";
  onPress?: () => void;
}

/** One line of a menu. */
export function MenuItem({
  children,
  icon,
  note,
  keyHint,
  checked,
  many,
  disabled,
  hue,
  dot,
  onPress,
}: MenuItemProps) {
  return (
    <button
      type="button"
      className="oh-control oh-menu-item"
      role={checked === undefined ? "menuitem" : many ? "menuitemcheckbox" : "menuitemradio"}
      aria-checked={checked}
      disabled={disabled}
      data-sub={hue === undefined ? undefined : ""}
      data-dot={dot ? "" : undefined}
      onClick={onPress}
    >
      {icon ? <Icon name={icon} size={20} /> : null}
      {dot ? <Dot kind={dot} /> : null}
      {hue === undefined ? null : <TagDot hue={hue} />}
      <span className="oh-menu-word">{children}</span>
      {note ? <small className="oh-menu-item-note">{note}</small> : null}
      {keyHint ? <KeyHint>{keyHint}</KeyHint> : null}
    </button>
  );
}
