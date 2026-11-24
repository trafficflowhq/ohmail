import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "../../base/index.js";
import type { IconName } from "../../icons/Icon.js";
import "./rail.css";

export interface RailProps {
  /** The landmark's name: "Places". */
  label: string;
  /** The way between the two products, where both are there. It stands first. */
  switcher?: ReactNode;
  /**
   * The way to write: a second button at the head, under the switch; it never scrolls away with the places.
   * `shortcut` is its key in `aria-keyshortcuts`' own spelling ("c"), said to a screen reader on the button.
   * `icon` is its sign where the head's one act is not writing (a console's Find); left out, the pen.
   */
  write?: { label: string; icon?: IconName; keyHint?: string; shortcut?: string; onPress?: () => void };
  /** The places, a group after a group, in the app's order. */
  groups: readonly ReactNode[];
  /** What stays on screen while the places scroll: the foot. */
  foot?: ReactNode;
  /** The phone drawer scrolls its foot with the places. */
  drawer?: boolean;
  /** The keys are in the rail: the face that rings the column with the keyboard draws its ring. */
  focused?: boolean;
  /** Which edge hides more before the rail has measured itself. Afterwards it says so by its own scroll. */
  clip?: "top" | "bottom" | "both";
}

type Clip = RailProps["clip"];

/* The places fade at the edge that hides more. */
function clipOf(scroll: HTMLElement): Clip {
  if (scroll.scrollHeight <= scroll.clientHeight + 1) return undefined;
  if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1) return "top";
  return scroll.scrollTop <= 0 ? "bottom" : "both";
}

/** Every place in the app's order, the way to write, and the account. */
export function Rail({ label, switcher, write, groups, foot, drawer, focused, clip }: RailProps) {
  const scroll = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const say = () => {
      const now = clipOf(el);
      if (now) el.dataset.clip = now;
      else delete el.dataset.clip;
    };
    say();
    el.addEventListener("scroll", say, { passive: true });
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(say) : null;
    watch?.observe(el);
    return () => {
      el.removeEventListener("scroll", say);
      watch?.disconnect();
    };
  }, [groups]);

  return (
    <nav
      className="oh-rail"
      aria-label={label}
      data-focused={focused ? "" : undefined}
      data-drawer={drawer ? "" : undefined}
      data-switcher={switcher ? "" : undefined}
    >
      {switcher}
      {write ? (
        <div className="oh-rail-write">
          <Button
            kind="two"
            icon={write.icon ?? "write"}
            keyHint={write.keyHint}
            shortcut={write.shortcut}
            onPress={write.onPress}
          >
            {write.label}
          </Button>
        </div>
      ) : null}
      <div ref={scroll} className="oh-rail-scroll" data-clip={clip}>
        {groups.map((group, index) => (
          <div key={index} className="oh-rail-group">
            {group}
          </div>
        ))}
        {drawer ? foot : null}
      </div>
      {drawer ? null : foot}
    </nav>
  );
}
