import { useEffect, useRef, useState } from "react";
import "./seg.css";

export interface SegmentOption<T extends string = string> {
  id: T;
  label: string;
  /** Optional count rendered after the label (Screener sections). */
  count?: number | string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  /** tablist for view-switching segments, group for value pickers. */
  role?: "tablist" | "group";
  /** Compact scope variant (decision bar). */
  variant?: "default" | "scope";
  className?: string;
}

/**
 * The row form's natural width: the segments' real rendered widths plus the capsule's own
 * padding. Read from the CHILDREN rather than the box, because as a stretched flex item the box
 * can be wider than its content and would over-report — and the over-report would then keep the
 * list stacked after the room came back.
 */
export function segNaturalWidth(el: HTMLElement): number {
  const cs = getComputedStyle(el);
  let w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  for (const child of el.children) w += (child as HTMLElement).getBoundingClientRect().width;
  return w;
}

/** The room the parent's content box offers this control, net of the control's own margins. */
export function segAvailableWidth(el: HTMLElement): number {
  const parent = el.parentElement;
  if (!parent) return Infinity;
  const p = getComputedStyle(parent);
  const m = getComputedStyle(el);
  return (
    parent.clientWidth -
    parseFloat(p.paddingLeft) - parseFloat(p.paddingRight) -
    parseFloat(m.marginLeft) - parseFloat(m.marginRight)
  );
}

/**
 * Stack when the row form cannot fit — the one rule; half a pixel of tolerance for rounding.
 *
 * An unreadable measurement is NOT an answer. `NaN > x` is `false`, which would read as "the row
 * fits" — the overflow direction, and the one this control exists to prevent. The caller rejects
 * a non-finite natural width before it gets here; this refuses it again rather than relying on
 * that, because the two agreeing is what makes the failure direction knowable.
 */
export function shouldStack(naturalPx: number, availPx: number): boolean {
  if (!Number.isFinite(naturalPx) || !Number.isFinite(availPx)) return true;
  return naturalPx > availPx + 0.5;
}

/**
 * Capsule segmented control; the active segment floats on lift-0.
 *
 * The control measures its own row form against the room its
 * parent gives it and switches to a stacked list (`data-stack`) when the row would overflow — see
 * `seg.css` for the two forms. The measurement is a ResizeObserver on the parent and on the
 * control itself; where none exists (a server render, a DOM without layout) the row form stands,
 * which is what every existing test renders. The natural width is remembered from the last row
 * measurement so a stacked list can tell when the room has come back, and it is forgotten when
 * the labels change (a locale switch, a count) so the next measurement reads the new words.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  ariaLabel,
  role = "group",
  variant = "default",
  className,
}: SegmentedControlProps<T>) {
  const counted = options.some((o) => o.count !== undefined);
  const ref = useRef<HTMLDivElement>(null);
  const naturalRef = useRef<number | null>(null);
  /** The font the remembered width was measured IN — see the invalidation in `measure`. */
  const fontRef = useRef<string | null>(null);
  const [stack, setStack] = useState(false);
  const labelsKey = options.map((o) => `${o.label}|${o.count ?? ""}`).join(" ");

  useEffect(() => {
    // New words: forget the old row width and measure the new one in row form.
    naturalRef.current = null;
    fontRef.current = null;
    setStack(false);
  }, [labelsKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined" || !el.parentElement) return;
    let frame = 0;
    const remeasure = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; measure(); });
    };
    const measure = () => {
      const avail = segAvailableWidth(el);
      if (!(avail > 0)) return;
      /* THE FONT IS A SECOND INPUT TO THE ROW'S WIDTH, and it can change without the labels: a
         face switch (the other face draws in a mono that runs wider), or a webfont finishing
         load. A width remembered in one font is not a measurement of the row in another, and
         reusing it is how a stacked list decides the row fits when it does not. */
      const cs = getComputedStyle(el);
      const font = `${cs.fontFamily}|${cs.fontSize}|${cs.fontWeight}|${cs.letterSpacing}`;
      if (font !== fontRef.current) {
        fontRef.current = font;
        naturalRef.current = null;
      }
      /**
       * THE DOM'S CURRENT FORM DECIDES WHETHER THE CHILDREN'S WIDTHS ARE THE ROW'S — not the
       * state, and not a ref beside it. In stacked form every segment is a full-width line, so
       * `segNaturalWidth` read there over-reports the row by a lot, and a control that measured
       * itself in the wrong form would stack for ever.
       *
       * The cost of reading the DOM is that it lags the state by one commit, and THAT was a real
       * defect: with nothing remembered and the attribute still set, the old code skipped the
       * read and then waited for an observer callback that need not come — the capsule is
       * `max-width: 100%`, so where the longest label is already as wide as the container,
       * changing form does not change the box and no resize fires. It could sit in row form with
       * `nowrap` segments painting outside the capsule, which is the defect this control exists
       * to remove. So the wait is replaced by an explicit re-measure on the next frame.
       */
      if (!el.hasAttribute("data-stack")) {
        naturalRef.current = segNaturalWidth(el);
      } else if (naturalRef.current == null) {
        // Stand in row form for one frame so the row can be measured at all, then come back.
        setStack(false);
        remeasure();
        return;
      }
      const natural = naturalRef.current;
      // A non-finite reading is not a measurement: half a read would decide the form on a guess,
      // and `NaN > x` is false — "the row fits", the overflow direction.
      if (natural == null || !Number.isFinite(natural) || natural <= 0) return;
      const next = shouldStack(natural, avail);
      setStack((prev) => (prev === next ? prev : next));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el.parentElement);
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [labelsKey]);

  const cls = ["seg", counted ? "counted" : null, variant === "scope" ? "scope" : null, className]
    .filter(Boolean)
    .join(" ");
  return (
    <div ref={ref} className={cls} role={role} aria-label={ariaLabel} data-stack={stack ? "" : undefined}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            role={role === "tablist" ? "tab" : undefined}
            aria-selected={role === "tablist" ? on : undefined}
            aria-pressed={role === "group" ? on : undefined}
            className={on ? "on" : undefined}
            onClick={() => onChange(o.id)}
          >
            {o.label}
            {o.count !== undefined ? <span className="scnt num">{o.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
