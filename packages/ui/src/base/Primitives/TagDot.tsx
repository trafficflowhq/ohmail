import { hueStyle } from "./hue.js";
import "./tag.css";

export interface TagDotProps {
  /** Left out: the hue of the tag it stands in. */
  hue?: number;
}

/** A tag's dot: where a tag is named without its capsule. */
export function TagDot({ hue }: TagDotProps) {
  return <i className="oh-tagdot" style={hue === undefined ? undefined : hueStyle(hue)} aria-hidden="true" />;
}
