import type { CSSProperties } from "react";
import { avatarHue, design, hueStyle } from "../../base/index.js";
import "./look-picture.css";

export type LookFace = keyof typeof design.faces;
export type LookScheme = "light" | "dark";

export interface LookPictureRow {
  /** Who wrote: their name, and its first letter in their circle. */
  who: string;
  /** Their address: it picks the circle's hue, as in every list. */
  address: string;
  /** When, as the list says it: "09:12". */
  time: string;
}

export interface LookPictureProps {
  /** The face it shows. */
  face: LookFace;
  /** The scheme it is drawn in: the app's resolved scheme (the frame stamps it), never read here. */
  scheme: LookScheme;
  /** The place it shows, the title with the hot dot: "Ohbox". */
  title: string;
  /** Two rows: the first unread and open, the second unread. */
  rows: readonly [LookPictureRow, LookPictureRow];
}

/**
 * Every value of a face in a scheme, as custom properties: all of them, at the pointer's sizes, from the tokens'
 * own data. A name left off would silently wear the page's face, so none is chosen.
 */
const values = (face: LookFace, scheme: LookScheme): CSSProperties =>
  Object.fromEntries(
    Object.entries(design.faces[face][scheme]).map(([name, value]) => [`--${name}`, value]),
  ) as CSSProperties;

/**
 * A look shown in itself: the Ohbox's title and two rows, drawn in a face's own values whichever face the page
 * wears, so a face's picture is the same on every page. It is not heard: the tile it stands in is named.
 */
export function LookPicture({ face, scheme, title, rows }: LookPictureProps) {
  return (
    <span className="oh-lookpic" data-face={face} aria-hidden="true" style={values(face, scheme)}>
      <span className="oh-lookpic-sheet">
        <b className="oh-lookpic-title">
          {title}
          <i className="oh-lookpic-hot" />
        </b>
        {rows.map((row, index) => (
          <span key={index} className="oh-lookpic-row" data-open={index === 0 ? "" : undefined}>
            <span className="oh-lookpic-circle" style={hueStyle(avatarHue(row.address))}>
              {[...(row.who.trim() || row.address.trim() || "?")][0]!.toUpperCase()}
              <i className="oh-lookpic-dot" />
            </span>
            <span className="oh-lookpic-line">
              <b className="oh-lookpic-who">{row.who}</b>
              <span className="oh-lookpic-room" />
              <time className="oh-lookpic-time">{row.time}</time>
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}
