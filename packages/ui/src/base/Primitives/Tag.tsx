import { hueStyle } from "./hue.js";
import "./tag.css";
import { TagDot } from "./TagDot.js";

export interface TagProps {
  /** The pile's or the tag's name, or the fact in a word or two. */
  children: string;
  /** A tag of the person's own: the hue of its dot. Left out: a pile, a plain capsule. */
  hue?: number;
  title?: string;
}

/**
 * A pile, a tag of the person's own with its dot, or a short fact about what it stands beside ("2 held",
 * "Confirmed", "This device"). No capsule for anything else.
 */
export function Tag({ children, hue, title }: TagProps) {
  if (hue === undefined)
    return (
      <span className="oh-tag" title={title}>
        {children}
      </span>
    );
  return (
    <span className="oh-tag" data-own="" title={title ?? children} style={hueStyle(hue)}>
      <TagDot />
      <span className="oh-tag-name">{children}</span>
    </span>
  );
}
