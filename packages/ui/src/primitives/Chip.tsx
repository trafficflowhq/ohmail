import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";
import { Kbd } from "./Kbd.js";
import "./chip.css";

export type TagHueName = "moss" | "ochre" | "rosewood";

/**
 * The tag hues the Blanc system paints, in the order a picker shows them. The single source of
 * this list on the client: `chip.css` has a `.hue-*` rule for each, `hueOf` clamps to it, and the
 * server's `TagsService.HUES` must equal it (a hue with no CSS rule is an invisible dot). Adding
 * one means adding a `--tg-*` family AND a `chip.css` rule in the same change.
 */
export const TAG_HUES: readonly TagHueName[] = ["moss", "ochre", "rosewood"];

export type ChipVariant =
  /** Routing rationale — route icon, tint capsule. */
  | "rationale"
  /** Tracker/privacy note — shield icon. */
  | "tracker"
  /** AI classification, awaiting approval — spark on accent-soft. */
  | "ai"
  /** Tag chip — hue capsule. */
  | "tag"
  /** Add-affordance (outline, input-like). */
  | "add";

const VARIANT_ICON: Record<Exclude<ChipVariant, "tag" | "add">, IconName> = {
  rationale: "route",
  tracker: "shield",
  ai: "spark",
};

export interface ChipAction {
  label: string;
  onPress: () => void;
}

export interface ChipProps {
  variant?: ChipVariant;
  /** Required for variant="tag". */
  hue?: TagHueName;
  /** Larger tag chip (reading pane). */
  big?: boolean;
  /** Inline mini-actions (Approve · Correct). */
  actions?: ChipAction[];
  /** Keyboard hint (add-affordance). */
  kbdHint?: string;
  onPress?: () => void;
  icon?: IconName | null;
  className?: string;
  children: ReactNode;
}

/** Capsule chip family: rationale / tracker / ai / tag / add. */
export function Chip({
  variant = "rationale",
  hue,
  big,
  actions,
  kbdHint,
  onPress,
  icon,
  className,
  children,
}: ChipProps) {
  if (variant === "tag") {
    const cls = ["tagchip", hue ? `hue-${hue}` : null, big ? "big" : null, className]
      .filter(Boolean)
      .join(" ");
    return <span className={cls}>{children}</span>;
  }
  if (variant === "add") {
    const cls = ["chip", "addtag", className].filter(Boolean).join(" ");
    return (
      <button type="button" className={cls} onClick={onPress}>
        <Icon name={icon ?? "plus"} size={11} />
        {children}
        {kbdHint ? <Kbd>{kbdHint}</Kbd> : null}
      </button>
    );
  }
  const cls = ["chip", variant === "ai" ? "pending" : null, className]
    .filter(Boolean)
    .join(" ");
  const iconName = icon === null ? null : (icon ?? VARIANT_ICON[variant]);
  return (
    // `data-chip` names the capsule variant (rationale / tracker / ai) without leaking into
    // the class or the styling. Nothing in the app reads it; it lets an outside surface (the
    // marketing page's embedded demo) anchor a pointer to a specific chip.
    <span className={cls} data-chip={variant}>
      {iconName ? <Icon name={iconName} size={12} /> : null}
      {children}
      {actions?.map((a, i) => (
        <span key={a.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {i > 0 ? <span style={{ opacity: 0.4 }}>·</span> : null}
          <button type="button" className="mini" onClick={a.onPress}>
            {a.label}
          </button>
        </span>
      ))}
    </span>
  );
}

export type BadgeVariant = "default" | "shield" | "place" | "ai";

export interface BadgeProps {
  variant?: BadgeVariant;
  icon?: IconName;
  className?: string;
  children?: ReactNode;
}

/** Small in-row capsule (thread count, held count, protected, AI suggestion). */
export function Badge({ variant = "default", icon, className, children }: BadgeProps) {
  const cls = ["badge", variant !== "default" ? variant : null, "num", className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={cls}>
      {icon ? <Icon name={icon} size={10} /> : null}
      {children}
    </span>
  );
}

export interface TagDotProps {
  hue: TagHueName;
  className?: string;
}

/** The small square-ish tag dot used in the rail and settings. */
export function TagDot({ hue, className }: TagDotProps) {
  return <span className={["tdot", `hue-${hue}`, className].filter(Boolean).join(" ")} />;
}
