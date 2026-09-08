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
 * A STANDING BANNER AT THE HEAD OF A LIST — pinned on a desktop, in the flow on a phone.
 *
 * One element, one stylesheet rule decides its form, and the rule is a media query on the shell's
 * own breakpoint (`layout.mobileMax` in `@ohmail/tokens`, 900 — the same 901px the rail, the
 * split and every other width decision in the shell already turn on). At and above it the banner
 * is `position: sticky` at the top of the scroller it is the first block of, so it stays in view
 * while the rows pass under it. Below it the banner is a block like any other: it is read at the
 * top and it scrolls away with the first swipe, which on a phone is the difference between a
 * notice and a toolbar.
 *
 * WHERE IT GOES is part of the design: the banner is the scroller's FIRST CHILD, not a sibling of
 * the scroller above it. Outside the scroller it could only ever be pinned; inside it, the one
 * media rule gives both forms without a line of JavaScript deciding the width — which is the whole
 * reason there is no `useNarrow()` here and must never be one.
 *
 * The look is the standing pane the away notice already wears: the soft accent wash, the card
 * radius, a 2px rule down the leading edge so the eye finds an object before it reads a sentence.
 * Not an alert — no warning colour, no icon — because what a banner states here is normal and
 * usually wanted. Pinned, it paints the wash over the PANEL ground rather than over whatever row
 * is passing under it: the wash is translucent by design and a row showing through it would make
 * the sentence unreadable at exactly the moment it is pinned.
 */
export function Banner({ children, action, role = "status", className }: BannerProps) {
  return (
    <div className={className ? `banner ${className}` : "banner"} role={role}>
      <span className="banner-text">{children}</span>
      {action ? <span className="banner-act">{action}</span> : null}
    </div>
  );
}
