/**
 * THE FRAME'S THREE STAMPS BEFORE THE FIRST PAINT: the scheme, the device and the pointer, on the document's element,
 * as `attributesOf(layoutPlan(window), look, window)` will stamp them once the frame mounts. The frame stays their
 * owner; this only says the same thing earlier, so the first server-drawn part of the kit finds them. No React and no
 * value import: the inline script is this function's own text, run with the page's `document` and `window`.
 */
export function stampFrameAttributes(doc: Document, win: Window): void {
  const root = doc.documentElement;
  const theme = root.getAttribute("data-theme");
  const dark =
    theme === "dark" || (theme !== "light" && !!win.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const coarse = !!win.matchMedia?.("(pointer: coarse)").matches;
  const width = win.innerWidth;
  root.setAttribute("data-scheme", dark ? "dark" : "light");
  /* One column under 700 wide, as `layoutPlan` draws it; this script's text stands alone, so the number is written. */
  root.setAttribute("data-device", width < 700 ? "phone" : width < 840 || coarse ? "fold" : "desktop");
  root.setAttribute("data-touch", coarse ? "1" : "0");
}

/** The stamps as a script's text, for a document that inlines its pre-paint scripts. It takes nothing from the request. */
export function frameBootScript(): string {
  return `(${stampFrameAttributes.toString()})(document, window);`;
}
