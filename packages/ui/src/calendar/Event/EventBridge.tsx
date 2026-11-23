import { useId, useState, type CSSProperties } from "react";
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
  const [settled, settle] = useState(false);
  const id = `oh-bridge-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const edge = `${id}-edge`;
  const skin = `${id}-skin`;
  const sheet = `${id}-sheet`;
  const head = `${id}-head`;
  const tint = "var(--oh-bridge-tint)";
  const shape = bridgeShape(input);
  if (!shape) return null;
  const own = toneOf(tone);
  const turn = shape.turned ? "matrix(0 1 1 0 0 0)" : undefined;
  const low = shape.turned ? "top" : "left";
  const high = shape.turned ? "bottom" : "right";
  const cardFirst = input.side === "l" || input.side === "t";
  const from = input.event.box[cardFirst ? low : high];
  const to = input.card.box[cardFirst ? high : low];
  const headEnd = input.card.headBottom ?? height;
  const fadesAlongSide = !shape.turned && headEnd < shape.bottom;
  const fill = (d: string, paint: string) => <path d={d} fill={paint} />;
  const form = (name: "liquid" | "straight", { fill: path, sides }: BridgeForm) => (
    <g className="oh-bridge-form" data-form={name} transform={turn}>
      {fadesAlongSide ? (
        <>
          <g clipPath={`url(#${head})`}>{fill(path, tint)}</g>
          <g clipPath={`url(#${sheet})`}>{fill(path, `url(#${skin})`)}</g>
        </>
      ) : (
        fill(path, input.side === "t" ? `url(#${skin})` : tint)
      )}
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
      data-still={still || settled ? "" : undefined}
      onAnimationEnd={(event) => {
        if (event.currentTarget === event.target) settle(true);
      }}
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
        <linearGradient id={skin} gradientUnits="userSpaceOnUse" x1={from} y1={0} x2={to} y2={0}>
          <stop className="oh-bridge-skin-event" offset="0" />
          <stop className="oh-bridge-skin-sheet" offset="1" />
        </linearGradient>
        {fadesAlongSide && (
          <>
            <clipPath id={head}>
              <rect x="0" y="0" width={width} height={Math.max(0, headEnd)} />
            </clipPath>
            <clipPath id={sheet}>
              <rect x="0" y={Math.max(0, headEnd)} width={width} height={height} />
            </clipPath>
          </>
        )}
      </defs>
      {form("liquid", shape.liquid)}
      {form("straight", shape.straight)}
    </svg>
  );
}
