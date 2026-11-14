import "./icons.css";
import data from "./icons.json" with { type: "json" };

/** Every icon of the design, by name: the words it is found by and its drawing on the 24 grid. */
export const icons = data.icons;
export type IconName = keyof typeof icons;

/** The sizes an icon is drawn at. `icons.json` lists the same ones; the icons' test holds the two equal. */
export const ICON_SIZES = [16, 18, 20, 22, 24] as const;
export type IconSize = (typeof ICON_SIZES)[number];

export interface IconProps {
  name: IconName;
  size: IconSize;
  /** What the icon says when it stands alone. Without it the icon is decoration beside a word. */
  label?: string;
  className?: string;
}

/**
 * One icon. It is drawn in the colour of the text around it, and the face draws its line:
 * the stroke's width, cap and join are tokens (`icons.css`), so the same drawing is round on
 * one face and square on the other.
 */
export function Icon({ name, size, label, className }: IconProps) {
  const named = label ? ({ role: "img", "aria-label": label } as const) : ({ "aria-hidden": true } as const);
  return (
    <svg
      className={className ? `oh-icon ${className}` : "oh-icon"}
      viewBox={`0 0 ${data.grid} ${data.grid}`}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      {...named}
      // The markup is this package's own file, and its test admits shapes and geometry only.
      dangerouslySetInnerHTML={{ __html: icons[name].svg }}
    />
  );
}
