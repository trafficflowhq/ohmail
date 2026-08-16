"use client";

import {
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * Scroll reveal that never gates content: children are fully visible by
 * default (no-JS, headless renderers, reduced motion all see the final
 * state). Only when JS runs, motion is allowed, and the element is still
 * below the viewport do we set data-reveal="pending" and let the
 * IntersectionObserver flip it to "in".
 */
export function Reveal({
  children,
  as: Tag = "div",
  className,
  delay = 0,
  style,
}: {
  children: ReactNode;
  as?: "div" | "section" | "li" | "span" | "p";
  className?: string;
  delay?: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = el.getBoundingClientRect();
    // Already on screen (or above it): stay visible, no entrance.
    if (rect.top < window.innerHeight * 0.92) return;
    el.dataset.reveal = "pending";
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            el.dataset.reveal = "in";
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={className}
      style={delay ? ({ ...style, "--reveal-delay": `${delay}ms` } as CSSProperties) : style}
    >
      {children}
    </Tag>
  );
}
