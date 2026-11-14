import { Dot, type DotProps } from "./Dot.js";

export interface EndDotProps extends DotProps {
  /** The words the dot ends. The last word and the dot never part at a line's end. */
  children: string;
}

/** Words that end in the full stop. */
export function EndDot({ children, kind, product }: EndDotProps) {
  const cut = children.lastIndexOf(" ");
  return (
    <>
      {cut < 0 ? "" : children.slice(0, cut + 1)}
      <span className="oh-nowrap">
        {children.slice(cut + 1)}
        <Dot kind={kind} product={product} />
      </span>
    </>
  );
}
