import { Menu, type MenuProps } from "./Menu.js";

export type PhoneSheetProps = Omit<MenuProps, "anchor" | "up" | "right" | "wide" | "anchored">;

/**
 * What comes up from the foot in place of a popover: the same content as the menu or the card, in
 * the same order, with the same keys. On the phone every menu takes this form by itself; this is
 * the form asked for by name, wherever a finger is used.
 */
export function PhoneSheet(props: PhoneSheetProps) {
  return <Menu {...props} />;
}
