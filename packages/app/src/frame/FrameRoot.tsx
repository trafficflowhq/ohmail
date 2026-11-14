/**
 * THE APP'S ROOT: the `.oh-root` element every part stands in, and the root attributes the new design's
 * variants read, stamped on the document's element. The face and the old theme stay the old theme
 * provider's: the frame writes `data-face` only where it finds none, and takes away only what it wrote. The document
 * is the one the root element was drawn in, never a global.
 */
import { useLayoutEffect, type ReactNode, type RefObject } from "react";
import { useGlass } from "./glass.js";
import { ROOT_ATTRIBUTES, type RootAttribute } from "./root-attributes.js";

export function FrameRoot({
  drawn,
  attributes,
  held,
  children,
}: {
  /** The root element, held by the frame: a part that needs its window reads it here and draws no node to find it. */
  drawn: RefObject<HTMLDivElement | null>;
  attributes: Record<RootAttribute, string | null>;
  held: boolean;
  children: ReactNode;
}) {
  useGlass(drawn);
  useLayoutEffect(() => {
    const root = drawn.current!.ownerDocument.documentElement;
    if (root.hasAttribute("data-face")) return;
    root.setAttribute("data-face", "paper");
    return () => root.removeAttribute("data-face");
  }, [drawn]);
  useLayoutEffect(() => {
    const root = drawn.current!.ownerDocument.documentElement;
    const before = ROOT_ATTRIBUTES.map((name) => [name, root.getAttribute(name)] as const);
    for (const name of ROOT_ATTRIBUTES) {
      const value = attributes[name];
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
    return () => {
      for (const [name, value] of before) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
    };
  }, [drawn, attributes]);
  return (
    <div ref={drawn} className="oh-root fr-root" data-held={held ? "" : undefined}>
      {children}
    </div>
  );
}
