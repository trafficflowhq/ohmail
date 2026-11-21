import { useId, type CSSProperties } from "react";
import { cx, toneOf, toneStyle, type CalendarTone } from "../tone.js";
import { bridgeShape, type BridgeForm, type BridgeInput } from "./bridge-shape.js";
import "./event-bridge.css";

export interface EventBridgeProps extends BridgeInput {
  /** Whose the event is: the bridge wears the open event's colour and its line. */
  tone: CalendarTone;
  /** The column it is drawn over, the frame every box is measured in. */
  width: number;
  height: number;
  /** It stood already (the hours scrolled, the window changed): it does not grow in again. */
  still?: boolean;
}

/**
 * What joins an open event and its card where they stand beside each other: one shape, the liquid
 * between two bubbles that are almost apart. It carries the line of the two rings along its sides, so
 * the two outlines become one. It is drawn whole or not at all, takes no press and says nothing.
 *
 * The app places the card, measures both and draws this over the same column; `bridgeShape` gives the
 * app the point the card grows from.
 */
export function EventBridge({ tone, width, height, still, ...input }: EventBridgeProps) {
  const edge = `oh-bridge-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const shape = bridgeShape(input);
  if (!shape) return null;
  const own = toneOf(tone);
  const turn = shape.turned ? "matrix(0 1 1 0 0 0)" : undefined;
  const form = (name: "liquid" | "straight", { fill, sides }: BridgeForm) => (
    <g className="oh-bridge-form" data-form={name} transform={turn}>
      <path className="oh-bridge-fill" d={fill} fill="var(--oh-cal-open, var(--oh-cal-open-plain))" />
      {sides.map((d) => (
        <path key={d} className="oh-bridge-edge" d={d} />
      ))}
    </g>
  );
  return (
    <svg
      className={cx("oh-bridge", own.className)}
      data-tone={own["data-tone"]}
      data-side={input.side}
      data-still={still ? "" : undefined}
      aria-hidden
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={
        {
          ...toneStyle(tone),
          transformOrigin: `${shape.root.x}px ${shape.root.y}px`,
          "--oh-bridge-gradient": `url(#${edge})`,
        } as CSSProperties
      }
    >
      <defs>
        <linearGradient id={edge} gradientUnits="userSpaceOnUse" x1={shape.from} y1={0} x2={shape.to} y2={0}>
          <stop className="oh-bridge-edge-start" offset="0" />
          <stop className="oh-bridge-edge-end" offset="1" />
        </linearGradient>
      </defs>
      {form("liquid", shape.liquid)}
      {form("straight", shape.straight)}
    </svg>
  );
}
