import { Icon, type IconName } from "../../icons/Icon.js";
import type { AvatarSize } from "./Avatar.js";
import "./avatar.css";
import { Dot } from "./Dot.js";

export interface SignProps {
  icon: IconName;
  size?: AvatarSize;
  unread?: boolean;
}

/** The sign of a row that is not a person: the circle's shape and place, an icon in it. */
export function Sign({ icon, size, unread }: SignProps) {
  return (
    <span className="oh-avatar" data-sign="" data-size={size} aria-hidden="true">
      <Icon name={icon} size={size === "xs" ? 16 : size === "s" ? 18 : 20} />
      {unread ? <Dot kind="hot" /> : null}
    </span>
  );
}
