import "./avatar.css";
import { Dot } from "./Dot.js";
import { avatarHue, hueStyle } from "./hue.js";

export type AvatarSize = "l" | "s" | "xs";

export interface AvatarProps {
  /** The person's name: its first letter is drawn. */
  name: string;
  /** The person's address: it picks the hue. */
  address: string;
  /** `l` a card, `s` the account, `xs` a byline. Left out: a row, a message. */
  size?: AvatarSize;
  /** The unread dot on its shoulder. */
  unread?: boolean;
}

/** Who it is: one letter in one of eight hues. Hidden from a screen reader: the name stands beside it. */
export function Avatar({ name, address, size, unread }: AvatarProps) {
  const letter = [...(name.trim() || address.trim() || "?")][0]!.toUpperCase();
  return (
    <span className="oh-avatar" data-size={size} style={hueStyle(avatarHue(address))} aria-hidden="true">
      {letter}
      {unread ? <Dot kind="hot" /> : null}
    </span>
  );
}
