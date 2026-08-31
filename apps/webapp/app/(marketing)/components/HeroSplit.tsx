"use client";

import { useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslations } from "next-intl";

/**
 * The hero split — the page's FIRST visual (OHMARCHY-PLAN.md §5): the same screen in
 * both faces at once, cut by a diagonal divider, so everyone gets the two-faces story
 * in one glance before the live demo below proves either of them.
 *
 * A DRAG-DIVIDER over the static floor: the ohmarchy capture sits above the paper one,
 * clipped along a slanted edge whose position is `--cut`; dragging (or pressing the
 * page anywhere on the figure, or arrow keys on the handle) moves the cut. With JS off
 * the default cut simply stands — the static split IS the designed fallback, not a
 * degraded one.
 *
 * Four captures, all from the automated pipeline (apps/webapp/scripts/landing-shots.mjs
 * shoots the live demo — the SAME screen, both faces, both schemes), swapped per scheme by
 * the `.is-light`/`.is-dark` rule the Views stills established. Both faces' images are
 * deliberately visible at once here — the one place on the page the face-visibility
 * mechanism must NOT apply.
 *
 * Sides are fixed — paper left, ohmarchy right — in both site faces: the figure is a
 * comparison, not a mirror of the current choice, and a stable geometry is what lets
 * the corner tags be read as labels rather than as state.
 */

const CUT_DEFAULT = 56;
const CUT_MIN = 12;
const CUT_MAX = 88;

const clamp = (v: number) => Math.min(CUT_MAX, Math.max(CUT_MIN, v));

export function HeroSplit() {
  const t = useTranslations("face");
  const [cut, setCut] = useState(CUT_DEFAULT);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const cutFromPointer = useCallback((clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (r.width === 0) return;
    setCut(clamp(((clientX - r.left) / r.width) * 100));
  }, []);

  /* Pointer capture on the figure itself: the first press places the cut, the drag
     rides it. Capture goes to the box so a fast drag that leaves the handle keeps
     working, and release anywhere ends it. */
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      dragging.current = true;
      boxRef.current?.setPointerCapture(e.pointerId);
      cutFromPointer(e.clientX);
    },
    [cutFromPointer],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (dragging.current) cutFromPointer(e.clientX);
    },
    [cutFromPointer],
  );
  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setCut((c) => clamp(c - 4));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setCut((c) => clamp(c + 4));
    } else if (e.key === "Home") {
      e.preventDefault();
      setCut(CUT_MIN);
    } else if (e.key === "End") {
      e.preventDefault();
      setCut(CUT_MAX);
    }
  }, []);

  return (
    <figure className="l-hsplit-wrap l-rise" style={{ "--rise": "5.4" } as CSSProperties}>
      <div
        className="l-hsplit"
        ref={boxRef}
        style={{ "--cut": `${cut}%` } as CSSProperties}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {/* the paper ground — full frame, scheme-swapped */}
        <img
          className="l-hsplit-img is-light"
          src="/landing/hero-paper.webp"
          width={1440}
          height={900}
          alt={t("splitAltPaper")}
          decoding="async"
        />
        <img
          className="l-hsplit-img is-dark"
          src="/landing/hero-paper-dark.webp"
          width={1440}
          height={900}
          alt={t("splitAltPaper")}
          decoding="async"
        />
        {/* the ohmarchy layer, clipped along the slanted cut */}
        <div className="l-hsplit-b" aria-hidden={false}>
          <img
            className="l-hsplit-img is-light"
            src="/landing/hero-ohmarchy.webp"
            width={1440}
            height={900}
            alt={t("splitAltOhmarchy")}
            decoding="async"
          />
          <img
            className="l-hsplit-img is-dark"
            src="/landing/hero-ohmarchy-dark.webp"
            width={1440}
            height={900}
            alt={t("splitAltOhmarchy")}
            decoding="async"
          />
        </div>
        {/* the divider: a drawn line plus the one focusable control */}
        <div className="l-hsplit-line" aria-hidden="true" />
        <div
          className="l-hsplit-handle"
          role="slider"
          tabIndex={0}
          aria-label={t("splitHandle")}
          aria-valuemin={CUT_MIN}
          aria-valuemax={CUT_MAX}
          aria-valuenow={Math.round(cut)}
          aria-valuetext={t("splitValue", { paper: Math.round(cut), ohmarchy: 100 - Math.round(cut) })}
          onKeyDown={onKeyDown}
        />
        <span className="l-hsplit-tag is-a" aria-hidden="true">
          {t("paper")}
        </span>
        <span className="l-hsplit-tag is-b" aria-hidden="true">
          {t("ohmarchy")}
        </span>
      </div>
      <figcaption className="l-hsplit-cap">{t("splitCaption")}</figcaption>
    </figure>
  );
}
