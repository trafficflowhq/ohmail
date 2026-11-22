import { Dot, type DotProps } from "./Dot.js";

export interface EndDotProps extends DotProps {
  /** The words the dot ends. The last word and the dot never part at a line's end. */
  children: string;
}

/** Words that end in the full stop. */
export function EndDot({ children, kind, product }: EndDotProps) {
  const words = children.trimEnd().replace(/(?<!\.)\.$/u, "");
  const cut = words.lastIndexOf(" ");
  return (
    <>
      {cut < 0 ? "" : words.slice(0, cut + 1)}
      <span className="oh-nowrap">
        {words.slice(cut + 1)}
        <Dot kind={kind} product={product} />
      </span>
    </>
  );
}
