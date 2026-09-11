import type { ReactNode } from "react";
import "./banner.css";

export interface BannerProps {
  /** The standing fact, one sentence. The same string in both forms — the banner never rewords by width. */
  children: ReactNode;
  /** The one verb, or nothing. A plain `<button>`; the banner dresses it as the quiet accent capsule. */
  action?: ReactNode;
  /**
   * `status` (the default) for a condition a screen reader should hear once and not be interrupted
   * by — the away responder being on. `note` for a fact that carries no change at all.
   */
  role?: "status" | "note";
  className?: string;
}

/**
 * A standing banner at the head of a list — pinned on a desktop, in the
 * flow on a phone. A media query on the shell's breakpoint
 * (`layout.mobileMax`, 900) decides the form: at and above, sticky at the
 * top of its scroller; below, a block that scrolls away. It must be the
 * scroller's first child — one media rule then gives both forms with no
 * JavaScript width decision (no `useNarrow()` here, ever). Look: the away
 * notice's standing pane, not an alert; pinned, the translucent wash
 * paints over the panel ground so passing rows cannot show through it.
 */
export function Banner({ children, action, role = "status", className }: BannerProps) {
  return (
    <div className={className ? `banner ${className}` : "banner"} role={role}>
      <span className="banner-text">{children}</span>
      {action ? <span className="banner-act">{action}</span> : null}
    </div>
  );
}
