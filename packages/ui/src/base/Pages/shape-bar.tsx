import type { CSSProperties } from "react";
import "./shape-bar.css";

const wide = (part: number): CSSProperties => ({ "--oh-shapebar-part": `${part}%` }) as CSSProperties;

/** One bar of a screen drawn as shape: as wide as the part of a hundred it is handed. */
export const Bar = ({ part, as }: { part?: number; as?: string }) => (
  <i className="oh-shapebar" data-as={as} style={part === undefined ? undefined : wide(part)} />
);
