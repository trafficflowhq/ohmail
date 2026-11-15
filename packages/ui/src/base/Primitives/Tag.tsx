import { hueStyle } from "./hue.js";
import "./tag.css";
import { TagDot } from "./TagDot.js";

export interface TagProps {
  /** The pile's or the tag's name. */
  children: string;
  /** A tag of the person's own: the hue of its dot. Left out: a pile, a plain capsule. */
  hue?: number;
}

/** A pile, or a tag of the person's own with its dot. No capsule for anything else. */
export function Tag({ children, hue }: TagProps) {
  if (hue === undefined) return <span className="oh-tag">{children}</span>;
  return (
    <span className="oh-tag" data-own="" title={children} style={hueStyle(hue)}>
      <TagDot />
      <span className="oh-tag-name">{children}</span>
    </span>
  );
}
