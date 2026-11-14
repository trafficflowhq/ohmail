/**
 * THE APP'S ROOT: the `.oh-root` element every part stands in, and the root attributes the new design's
 * variants read, stamped on the document's element. The face and the old theme stay the old theme
 * provider's: the frame writes `data-face` only where it finds none, and takes away only what it wrote. The document
 * is the one the root element was drawn in, never a global.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useGlass } from "./glass.js";
import { ROOT_ATTRIBUTES, type RootAttribute } from "./root-attributes.js";

export function FrameRoot({
  attributes,
  held,
  children,
}: {
  attributes: Record<RootAttribute, string | null>;
  held: boolean;
  children: ReactNode;
}) {
  const drawn = useRef<HTMLDivElement>(null);
  useGlass(drawn);
  useLayoutEffect(() => {
    const root = drawn.current!.ownerDocument.documentElement;
    if (root.hasAttribute("data-face")) return;
    root.setAttribute("data-face", "paper");
    return () => root.removeAttribute("data-face");
  }, []);
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
  }, [attributes]);
  return (
    <div ref={drawn} className="oh-root fr-root" data-held={held ? "" : undefined}>
      {children}
    </div>
  );
}
