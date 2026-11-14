import type { CSSProperties } from "react";
import "./designed-letter.css";

/**
 * What the frame may do: read its own size and open a link in a new place. It runs no script, sends
 * no form and never moves the window; no input widens this.
 */
export const LETTER_SANDBOX = "allow-same-origin allow-popups allow-popups-to-escape-sandbox";

/** A link the app answers for: its press area lies over the link, outside the letter. */
export interface LetterLink {
  /** The link's words. */
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
  onPress?: (anchor: HTMLElement) => void;
}

export interface DesignedLetterProps {
  /** The frame's name for a screen reader. */
  title: string;
  /** The letter as one document, made safe by the app: it carries its own content policy. */
  document: string;
  /** The letter's own paper, a colour it brings. Left out: the sheet's. */
  paper?: string;
  /** How tall the document is, once the app has read it. The frame never scrolls by itself. */
  height?: number;
  /** The frame has loaded its document: the app reads its size and its links here. */
  onLoad?: (frame: HTMLIFrameElement) => void;
  links?: readonly LetterLink[];
}

/** A letter that brings its own layout, drawn as its sender made it in a frame that runs nothing. */
export function DesignedLetter({ title, document, paper, height, onLoad, links }: DesignedLetterProps) {
  const own = paper ? ({ "--oh-letter-paper": paper } as CSSProperties) : undefined;
  return (
    <div className="oh-designedletter" style={own}>
      <div className="oh-designedletter-sheet">
        <iframe
          className="oh-designedletter-frame"
          title={title}
          sandbox={LETTER_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={document}
          style={height === undefined ? undefined : { height }}
          onLoad={onLoad ? (event) => onLoad(event.currentTarget) : undefined}
        />
        {links?.map((link, i) => (
          <button
            key={i}
            type="button"
            className="oh-control oh-designedletter-link"
            aria-label={link.label}
            style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
            onClick={(event) => link.onPress?.(event.currentTarget)}
          />
        ))}
      </div>
    </div>
  );
}
