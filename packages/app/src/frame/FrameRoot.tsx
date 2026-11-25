/**
 * THE APP'S ROOT: the `.oh-root` element every part stands in, and the root attributes the new design's
 * variants read, stamped on the document's element. The face and the old theme stay the old theme
 * provider's: the frame writes `data-face` only where it finds none, and takes away only what it wrote. The document
 * is the one the root element was drawn in, never a global.
 */
import { createContext, useContext, useLayoutEffect, type ReactNode, type RefObject } from "react";
import { design } from "@ohmail/ui/base";
import { useGlass } from "./glass.js";
import "./placement.css";
import "./seam.generated.css";
import { ROOT_ATTRIBUTES, type RootAttribute } from "./root-attributes.js";

const FrameElement = createContext<RefObject<HTMLDivElement | null> | null>(null);

/** The element whose document owns the frame and its panes. */
export function useFrameElement() {
  return useContext(FrameElement);
}

type FrameRootProps = {
  /** The root element, held by the frame: a part that needs its window reads it here and draws no node to find it. */
  drawn: RefObject<HTMLDivElement | null>;
  attributes: Record<RootAttribute, string | null>;
  held?: boolean;
  children: ReactNode;
};

export function FrameRoot(props: FrameRootProps) {
  useGlass(props.drawn);
  return <FrameSurface {...props} />;
}

export function FrameSurface({ drawn, attributes, held, children }: FrameRootProps) {
  useLayoutEffect(() => {
    const root = drawn.current!.ownerDocument.documentElement;
    if (root.hasAttribute("data-face")) return;
    root.setAttribute("data-face", "paper");
    return () => root.removeAttribute("data-face");
  }, [drawn]);
  useLayoutEffect(() => {
    const root = drawn.current!.ownerDocument.documentElement;
    const stampsAccent =
      attributes["data-product"] === "cal" &&
      root.dataset.accent === undefined &&
      root.dataset.face !== "ohmarchy";
    if (stampsAccent) {
      root.dataset.accent = design.productAccent.cal;
    }
    const before = ROOT_ATTRIBUTES.map((name) => [name, root.getAttribute(name)] as const);
    for (const name of ROOT_ATTRIBUTES) {
      const value = attributes[name];
      if (value === null) root.removeAttribute(name);
      else root.setAttribute(name, value);
    }
    return () => {
      if (stampsAccent && root.dataset.accent === design.productAccent.cal) delete root.dataset.accent;
      for (const [name, value] of before) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
    };
  }, [drawn, attributes]);
  return (
    <FrameElement.Provider value={drawn}>
      <div ref={drawn} className="oh-root fr-root" data-held={held ? "" : undefined}>
        {children}
      </div>
    </FrameElement.Provider>
  );
}
