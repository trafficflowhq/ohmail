import type { CSSProperties } from "react";
import "./scale-bar.css";

/** One part of the bar, in hundredths of its length; the parts stand one after the other from the bar's start. */
export interface ScaleBarPart {
  share: number;
  /** `second`: a second kind of the same thing. `rest`: what is still to come, hatched. Left out: the first kind, in the ink. */
  kind?: "second" | "rest";
}

export interface ScaleBarProps {
  /** What the picture shows, in words: the bar is one picture to a screen reader. */
  label: string;
  parts: readonly ScaleBarPart[];
  /** A line across the bar, with a label over it where the limit is not the bar's end: in hundredths of the bar. */
  marks?: readonly { at: number; label?: string }[];
  /** The captions under the bar, from its start to its end; `rest` leads one with the hatch it explains. */
  scale?: readonly { label: string; rest?: boolean }[];
}

const hundredths = (n: number) => `${Math.max(0, Math.min(100, n))}%`;

/** How much of something is used, to scale: parts of one bar, limits marked on it, and its scale under it. */
export function ScaleBar({ label, parts, marks, scale }: ScaleBarProps) {
  /* Each part starts where the one before it ends. */
  let from = 0;
  const laid = parts.map((part) => {
    const style = {
      "--oh-scalebar-from": hundredths(from),
      "--oh-scalebar-share": hundredths(part.share),
    } as CSSProperties;
    from += part.share;
    return { kind: part.kind, style };
  });
  return (
    <div className="oh-scalebar">
      <div className="oh-scalebar-bar" role="img" aria-label={label}>
        {laid.map((part, at) => (
          <i key={at} className="oh-scalebar-part" data-kind={part.kind} style={part.style} />
        ))}
        {marks?.map((mark) => (
          <span
            key={mark.at}
            className="oh-scalebar-mark"
            /* A label near an end of the bar is set from that end, so that it stays over the bar. */
            data-side={mark.at > 80 ? "end" : mark.at < 20 ? "start" : undefined}
            style={{ "--oh-scalebar-from": hundredths(mark.at) } as CSSProperties}
          >
            {mark.label ? <span className="oh-scalebar-label">{mark.label}</span> : null}
          </span>
        ))}
      </div>
      {scale?.length ? (
        <p className="oh-text oh-scalebar-scale">
          {scale.map((step) => (
            <span key={step.label} className="oh-scalebar-step">
              {step.rest ? <i className="oh-scalebar-hatch" /> : null}
              {step.label}
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}
