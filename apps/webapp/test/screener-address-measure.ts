import { expect } from "vitest";

type Reading = { visibleW: number; domainW: number; domainVisibleW: number; domainLines: number; inside: boolean; nameEm: number };

/** The address text inside `sel` as a person sees it: its rects against every clipping ancestor. */
export const readAddress = (sel: string): Reading => {
  const host = document.querySelector(sel) as HTMLElement | null;
  if (!host) return { visibleW: -1, domainW: -1, domainVisibleW: -1, domainLines: 0, inside: false, nameEm: -1 };
  const hidden = (el: Element) => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const c = getComputedStyle(e);
      if (c.display === "none" || c.visibility !== "visible" || c.clipPath === "inset(50%)") return true;
    }
    return false;
  };
  const clipOf = (el: Element) => {
    let L = -Infinity, R = Infinity, T = -Infinity, B = Infinity;
    for (let a: Element | null = el; a && a !== document.documentElement; a = a.parentElement) {
      const c = getComputedStyle(a), r = a.getBoundingClientRect();
      if (c.overflowX !== "visible") { L = Math.max(L, r.left); R = Math.min(R, r.right); }
      if (c.overflowY !== "visible") { T = Math.max(T, r.top); B = Math.min(B, r.bottom); }
    }
    return { L, R, T, B };
  };
  const text = host.textContent ?? "";
  const at = text.lastIndexOf("@");
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const nodes: { n: Text; start: number }[] = [];
  let off = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) { nodes.push({ n, start: off }); off += n.data.length; }
  /* Painted width: the union of the text's rects per line (an ellipsised run reports its full box
     AND its cut one), each first cut to the clip it is painted inside. */
  const line = (host.closest(".oh-row-first, .oh-messagehead-who, .row-top, .hm-line") as HTMLElement).getBoundingClientRect();
  let inside = true;
  const width = (from: number, to: number, clipped: boolean) => {
    const lines = new Map<number, [number, number][]>();
    for (const { n, start } of nodes) {
      const a = Math.max(from, start), b = Math.min(to, start + n.data.length);
      if (a >= b || hidden(n.parentElement!)) continue;
      const rg = document.createRange();
      rg.setStart(n, a - start);
      rg.setEnd(n, b - start);
      const k = clipOf(n.parentElement!);
      for (const r of rg.getClientRects()) {
        let [l, rr] = [r.left, r.right];
        if (clipped) {
          if (Math.min(r.bottom, k.B) <= Math.max(r.top, k.T)) continue;
          [l, rr] = [Math.max(l, k.L), Math.min(rr, k.R)];
        }
        if (clipped && rr > l && (l < line.left - 0.5 || rr > line.right + 0.5)) inside = false;
        if (rr > l) lines.set(Math.round(r.top), [...(lines.get(Math.round(r.top)) ?? []), [l, rr]]);
      }
    }
    let w = 0;
    for (const spans of lines.values()) {
      spans.sort((x, y) => x[0] - y[0]);
      let [cl, cr] = spans[0]!;
      for (const [l, r] of spans.slice(1)) { if (l <= cr) cr = Math.max(cr, r); else { w += cr - cl; [cl, cr] = [l, r]; } }
      w += cr - cl;
    }
    lines.size && (lastLines = lines.size);
    return w;
  };
  let lastLines = 0;
  const name = host.closest(".oh-row-first, .oh-messagehead-who, .row-top, .hm-line")?.querySelector(".oh-row-who, .oh-messagehead-name, .who, b") as HTMLElement | null;
  const visibleW = width(0, text.length, true);
  const domainW = width(at, text.length, false);
  const domainLines = lastLines;
  return {
    visibleW, domainW, domainVisibleW: width(at, text.length, true), domainLines, inside,
    nameEm: name ? name.clientWidth / parseFloat(getComputedStyle(name).fontSize) : -1,
  };
};

export const whole = (r: Reading, where: string) => {
  expect(r.visibleW, `${where}: the address is not on screen`).toBeGreaterThan(0);
  expect(r.domainW, `${where}: no domain measured`).toBeGreaterThan(0);
  expect(r.domainVisibleW, `${where}: the domain is cut (${r.domainVisibleW} of ${r.domainW}px)`).toBeGreaterThanOrEqual(r.domainW - 0.5);
  expect(r.inside, `${where}: the address runs out of its line`).toBe(true);
};
