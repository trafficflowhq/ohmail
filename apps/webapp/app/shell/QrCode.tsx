"use client";

/**
 * A QR of `value`, as inline SVG — the visual half of `shell/qr.ts`.
 *
 * Always dark-on-white, deliberately theme-blind: a QR is a print contract with a camera, not a
 * piece of the page's palette. An inverted (light-on-dark) code is out of spec and real phone
 * scanners refuse it, so the white quiet zone and the black modules are hard-coded rather than
 * tokens — in dark mode the white tile is the one element on the page that must not follow the
 * theme, and that is the feature.
 *
 * `role="img"` with a caller-supplied label: the label says what the code IS ("your invite link
 * as a QR code"), never the payload — reading a hundred characters of URL to a screen-reader
 * user is noise, and the copy button next to it is the accessible path to the value itself.
 *
 * The four-module quiet zone the spec requires is part of the viewBox, so no consumer can crop
 * it off with a tight container.
 */
import { useMemo } from "react";
import { qrEncode, qrSvgPath } from "./qr";

const QUIET = 4;

export function QrCode({ value, ariaLabel }: { value: string; ariaLabel: string }) {
  const { size, path } = useMemo(() => {
    const matrix = qrEncode(value);
    return { size: matrix.length, path: qrSvgPath(matrix) };
  }, [value]);
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`${-QUIET} ${-QUIET} ${size + 2 * QUIET} ${size + 2 * QUIET}`}
      shapeRendering="crispEdges"
    >
      <rect x={-QUIET} y={-QUIET} width={size + 2 * QUIET} height={size + 2 * QUIET} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
