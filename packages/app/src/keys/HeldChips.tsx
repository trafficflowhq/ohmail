import { useLayoutEffect, useRef } from "react";
import { KeyHint } from "@ohmail/ui/base";

const EDGE = 3;
const GAP = 2;
const EDGE_PAD = 3;

export interface ChipAnchor {
  control: HTMLElement;
  rect: DOMRect;
}

export interface HeldChip extends ChipAnchor {
  cap: string;
}

function labelRects(control: HTMLElement, view: Window): DOMRect[] {
  const page = control.ownerDocument;
  const words = page.createTreeWalker(control, NodeFilter.SHOW_TEXT);
  const range = page.createRange();
  const rects = [...control.querySelectorAll("svg")].map((icon) => icon.getBoundingClientRect());
  for (let word = words.nextNode(); word; word = words.nextNode()) {
    const parent = word.parentElement;
    if (!word.textContent?.trim() || !parent) continue;
    const style = view.getComputedStyle(parent);
    if (style.visibility !== "visible" || style.opacity === "0") continue;
    range.selectNodeContents(word);
    rects.push(...range.getClientRects());
  }
  return rects;
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right + GAP && a.right > b.left - GAP && a.top < b.bottom + GAP && a.bottom > b.top - GAP;
}

function position(
  chip: DOMRect,
  entry: HeldChip,
  labels: readonly DOMRect[],
  placed: DOMRect[],
  view: Window,
) {
  const { control, rect } = entry;
  const { width, height } = chip;
  const rtl = view.getComputedStyle(control).direction === "rtl";
  const trailing = new DOMRect(
    rtl ? rect.left + GAP : rect.right - width - GAP,
    rect.top + (rect.height - height) / 2,
    width,
    height,
  );
  const center = Math.max(
    EDGE,
    Math.min(view.innerWidth - width - EDGE, rect.left + (rect.width - width) / 2),
  );
  // Dense icon rows can use their edge padding if the space outside them is occupied.
  const edges = [
    rect.top - height - GAP,
    rect.bottom + GAP,
    rect.top - height + EDGE_PAD,
    rect.bottom - EDGE_PAD,
  ];
  const inWindow = (r: DOMRect) =>
    r.left >= EDGE &&
    r.right <= view.innerWidth - EDGE &&
    r.top >= EDGE &&
    r.bottom <= view.innerHeight - EDGE;
  const clear = (r: DOMRect) =>
    !labels.some((label) => intersects(r, label)) && !placed.some((key) => intersects(r, key));

  if (width + GAP * 2 <= rect.width && height <= rect.height && inWindow(trailing) && clear(trailing))
    return trailing;
  return (
    edges
      .map((y) => new DOMRect(center, y, width, height))
      .find((candidate) => inWindow(candidate) && clear(candidate)) ?? null
  );
}

export function HeldChips({
  entries,
  controls,
  view,
}: {
  entries: readonly HeldChip[];
  controls: readonly ChipAnchor[];
  view: Window;
}) {
  const nodes = useRef<Array<HTMLSpanElement | null>>([]);
  useLayoutEffect(() => {
    const layer = nodes.current[0]?.parentElement;
    if (!layer) return;
    const area = layer.getBoundingClientRect();
    const scaleX = layer.clientWidth ? area.width / layer.clientWidth : 1;
    const scaleY = layer.clientHeight ? area.height / layer.clientHeight : 1;
    const sizes = entries.map((_, index) => {
      const node = nodes.current[index]!;
      node.hidden = false;
      return node.getBoundingClientRect();
    });
    const labels = controls.flatMap(({ control, rect }) =>
      control.matches("input, textarea") ? [rect] : labelRects(control, view),
    );
    const placed: DOMRect[] = [];
    for (const [index, entry] of entries.entries()) {
      const node = nodes.current[index]!;
      const rect = position(sizes[index]!, entry, labels, placed, view);
      node.hidden = rect === null;
      if (!rect) continue;
      placed.push(rect);
      node.style.left = `${(rect.left - area.left) / scaleX}px`;
      node.style.top = `${(rect.top - area.top) / scaleY}px`;
    }
  }, [entries, controls, view]);

  return entries.map(({ cap }, index) => (
    <span
      className="fr-held-chip"
      key={index}
      ref={(node) => {
        nodes.current[index] = node;
      }}
    >
      <KeyHint shown unsaid quiet>
        {cap}
      </KeyHint>
    </span>
  ));
}
