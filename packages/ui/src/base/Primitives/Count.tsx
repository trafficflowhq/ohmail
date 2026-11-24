import { useEffect, useRef } from "react";
import { animate, motionShape } from "../../motion/motion.js";
import "./count.css";

export interface CountProps {
  /** The number as it is printed. Zero, and nothing, show nothing. */
  children: number | string | undefined;
  /** `point`: a number that is the point of what it stands in. */
  kind?: "point";
  size?: "xl";
  /** Settle once when the number changes. */
  ticks?: boolean;
}

/** A number, where the thing it counts is. */
export function Count({ children, kind, size, ticks }: CountProps) {
  const el = useRef<HTMLSpanElement | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const node = el.current;
    if (!ticks || !node) return;
    animate(node, "tick", {
      ease: "--e-out",
      keyframes: [
        { transform: "scale(1)" },
        { transform: motionShape(node, "--x-settle"), offset: 0.4 },
        { transform: "scale(1)" },
      ],
    });
  }, [children, ticks]);
  if (children === undefined || children === "" || children === 0 || children === "0") return null;
  return (
    <span ref={el} className="oh-count" data-kind={kind} data-size={size}>
      {children}
    </span>
  );
}
