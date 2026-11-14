/**
 * The bridge's shape, from numbers alone: where an open event and its card nearly touch, the liquid
 * between them. It stands on the event's edge and on the card's edge, over both rings; its two sides
 * leave each edge at a tangent, dip to a waist in the middle of the gap and rise again.
 *
 * Every box is in the frame of the column the bridge is drawn over, in CSS pixels. The app measures
 * the event and the card where it placed them and hands the numbers on; nothing here reads a page.
 */

export interface BridgeBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** One of the two bodies the bridge joins. */
export interface BridgeBody {
  /** As far as it is in sight: an event the scroll cuts ends where the hours end. */
  box: BridgeBox;
  /** The round of its corners. */
  radius: number;
  /** Its whole box where the scroll cuts it: a cut end is no corner. Left out: it is whole. */
  whole?: BridgeBox;
}

/** Where the card stands from its event: right, left, under, over, or on it. The card's own `side`. */
export type BridgeSide = "r" | "l" | "b" | "t" | "o";

export interface BridgeInput {
  event: BridgeBody;
  /** The card, and where its head ends: under the head the liquid meets the sheet. */
  card: BridgeBody & { headBottom?: number };
  side: BridgeSide;
  /** The width of the line that runs round both, as it is drawn. */
  line: number;
  /** Mail's marks in the column. The bridge never attaches where one stands in the gap. */
  marks?: readonly BridgeBox[];
  /** A gap between two screens: no bridge is drawn across it. One folding screen has none. */
  hinge?: { axis: "v" | "h"; at: number; width: number };
}

/** One form of the bridge as path data: what fills it, and its two sides. */
export interface BridgeForm {
  fill: string;
  sides: [string, string];
}

export interface BridgeShape {
  /** The sides dip to a waist. */
  liquid: BridgeForm;
  /** The sides run straight across, for the face that keeps square corners. */
  straight: BridgeForm;
  /** The two stretches of ring the bridge stands on: drawn over, so the two outlines become one. */
  ends: [string, string];
  endWidth: number;
  /** Under or over its event the same shape is drawn turned: across is down. */
  turned: boolean;
  /** Along the two edges, where it begins and ends. */
  top: number;
  bottom: number;
  /** Across the gap: at the event, at the card. The one fade runs between them. */
  from: number;
  to: number;
  /** The card's surface the liquid meets: its head, or the sheet under the head. */
  meets: "head" | "body";
  /** The point on the event's edge it grows out of. */
  root: { x: number; y: number };
  /** Its middle at the card's edge: where the card grows from. */
  middle: { x: number; y: number };
}

/** Half its height at the edges, so 32 px at most. */
const HALF = 16;
/** The waist's share of that. */
const WAIST = 0.4;
/** Under this half-height there is no bridge: never a stub. */
const LEAST = 5;
/** How far round a corner it may attach, in degrees: a side leaves the edge at 35° at most. */
const ARC = 55;
/** The widest gap it crosses. */
const GAP = 40;
/** The air round a mark of mail. */
const AIR = 2;

/** Which side of its event a card stands on, read from the two boxes. */
export function bridgeSide(event: BridgeBox, card: BridgeBox): BridgeSide {
  if (card.left >= event.right - 1) return "r";
  if (card.right <= event.left + 1) return "l";
  if (card.top >= event.bottom - 1) return "b";
  if (card.bottom <= event.top + 1) return "t";
  return "o";
}

/* The frame the shape is worked out in: x runs across the gap and y along the two edges. */
interface Frame {
  l: number;
  r: number;
  t: number;
  b: number;
}
interface Body {
  o: Frame;
  real: Frame;
  radius: number;
  /** The event's line lies inside its edge, the card's outside. */
  inside: boolean;
}
interface Ends {
  top: number;
  bottom: number;
  half: number;
}
interface Point {
  x: number;
  tx: number;
  ty: number;
  round?: number;
}

const n2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The bridge between an open event and its card, or `null` where it lets go: the card on its event,
 * a gap wider than 40 px, less than 10 px of edge in common, a hinge between two screens in the way.
 * It is drawn whole or not at all.
 */
export function bridgeShape({ event, card, side, line, marks = [], hinge }: BridgeInput): BridgeShape | null {
  if (side === "o") return null;
  const turned = side === "t" || side === "b";
  const frame = (o: BridgeBox): Frame =>
    turned
      ? { l: o.top, r: o.bottom, t: o.left, b: o.right }
      : { l: o.left, r: o.right, t: o.top, b: o.bottom };
  const eventFirst = side === "r" || side === "b";
  const e: Body = {
    o: frame(event.box),
    real: frame(event.whole ?? event.box),
    radius: event.radius,
    inside: true,
  };
  const k: Body = { o: frame(card.box), real: frame(card.box), radius: card.radius, inside: false };
  const L = eventFirst ? e : k;
  const R = eventFirst ? k : e;
  if (R.o.l - L.o.r > GAP) return null;

  const eL = endsOf(L, line);
  const eR = endsOf(R, line);
  const least = 1 - Math.cos((ARC * Math.PI) / 180);
  const a = Math.max(L.o.t + eL.top * least, R.o.t + eR.top * least);
  const z = Math.min(L.o.b - eL.bottom * least, R.o.b - eR.bottom * least);

  const part = partOf([a, z], marks.map(frame), Math.min(L.o.r, R.o.l), Math.max(L.o.r, R.o.l));
  if (!part) return null;
  const half = Math.min(HALF, (part[1] - part[0]) / 2);
  if (half < LEAST) return null;
  const y1 = part[0];
  const y2 = y1 + 2 * half;

  const point = (X: Body, en: Ends, right: boolean, y: number): Point => pointOn(X, en, right, y, line);
  const along = (X: Body, en: Ends, right: boolean, from: number, to: number): string =>
    alongRing(X, en, right, from, to, line);

  const near1 = point(L, eL, true, y1);
  const near2 = point(L, eL, true, y2);
  const far1 = point(R, eR, false, y1);
  const far2 = point(R, eR, false, y2);
  if (far1.x - near1.x < 2 || far2.x - near2.x < 2) return null;
  if (hinge) {
    const reach = hinge.width / 2 + 1;
    const across = (hinge.axis === "v") !== turned;
    const c0 = across ? Math.min(near1.x, far1.x) : y1;
    const c1 = across ? Math.max(near1.x, far1.x) : y2;
    if (hinge.at - reach < c1 && hinge.at + reach > c0) return null;
  }

  const edgeR = along(R, eR, false, y1, y2);
  const edgeL = along(L, eL, true, y2, y1);
  /* Each side leaves its ring at a tangent and dips to the waist; with no pull it runs straight across. */
  const formOf = (pull: number): BridgeForm => {
    const over = `M${n2(near1.x)} ${n2(y1)} C${n2(near1.x + pull * near1.tx)} ${n2(y1 + pull * near1.ty)} ${n2(far1.x + pull * far1.tx)} ${n2(y1 + pull * far1.ty)} ${n2(far1.x)} ${n2(y1)}`;
    const back = `C${n2(far2.x - pull * far2.tx)} ${n2(y2 - pull * far2.ty)} ${n2(near2.x - pull * near2.tx)} ${n2(y2 - pull * near2.ty)} ${n2(near2.x)} ${n2(y2)}`;
    return { fill: `${over}${edgeR}${back}${edgeL} Z`, sides: [over, `M${n2(far2.x)} ${n2(y2)} ${back}`] };
  };

  const middle = y1 + half;
  const atEvent = eventFirst ? near1.x : far1.x;
  const atCard = eventFirst ? far1.x : near1.x;
  /* Against the head the bridge is flat; under it, and where it meets the card's lower edge, the liquid thins into the sheet. */
  const headEnd = card.headBottom;
  const meets: BridgeShape["meets"] =
    side !== "b" && headEnd !== undefined && (side === "t" || middle > headEnd) ? "body" : "head";
  const swap = (x: number, y: number) => (turned ? { x: y, y: x } : { x, y });
  return {
    liquid: formOf((half - half * WAIST) / 0.75),
    straight: formOf(0),
    ends: [`M${n2(near1.x)} ${n2(y1)}${along(L, eL, true, y1, y2)}`, `M${n2(far1.x)} ${n2(y1)}${edgeR}`],
    endWidth: n2(line + 2),
    turned,
    top: y1,
    bottom: y2,
    from: n2(atEvent),
    to: n2(atCard),
    meets,
    root: swap(atEvent, middle),
    middle: swap(atCard, middle),
  };
}

/* A corner the scroll cut away is no corner: that end is straight. */
function endsOf(X: Body, line: number): Ends {
  const r = Math.min(X.radius, (X.o.b - X.o.t) / 2, (X.o.r - X.o.l) / 2);
  return {
    top: Math.abs(X.o.t - X.real.t) > 0.5 ? 0 : r,
    bottom: Math.abs(X.o.b - X.real.b) > 0.5 ? 0 : r,
    half: X.inside ? line / 2 : -line / 2,
  };
}

/** Of the two edges' common stretch less the marks, the first part that holds it whole, else the longest. */
function partOf(
  whole: [number, number],
  marks: readonly Frame[],
  g0: number,
  g1: number,
): [number, number] | undefined {
  let band: [number, number][] = [whole];
  for (const m of marks) {
    if (m.r - m.l <= 0 || Math.min(m.r, g1) - Math.max(m.l, g0) < (m.r - m.l) / 2) continue;
    band = band.flatMap(([s0, s1]): [number, number][] => {
      if (m.b + AIR <= s0 || m.t - AIR >= s1) return [[s0, s1]];
      const left: [number, number][] = [];
      if (m.t - AIR > s0) left.push([s0, m.t - AIR]);
      if (m.b + AIR < s1) left.push([m.b + AIR, s1]);
      return left;
    });
  }
  return (
    band.find(([s0, s1]) => s1 - s0 >= 2 * HALF) ?? [...band].sort((u, v) => v[1] - v[0] - (u[1] - u[0]))[0]
  );
}

/** A point on a body's ring (its centre line) at one height, on the edge that faces the gap, and the ring's way down there. */
function pointOn(X: Body, en: Ends, right: boolean, y: number, line: number): Point {
  const edge = right ? X.o.r : X.o.l;
  const atTop = y < X.o.t + en.top && en.top > 0;
  const atBottom = y > X.o.b - en.bottom && en.bottom > 0;
  if (!atTop && !atBottom) return { x: edge + (right ? -en.half : en.half), tx: 0, ty: 1 };
  const r = atTop ? en.top : en.bottom;
  const centre = atTop ? X.o.t + r : X.o.b - r;
  const round = X.inside ? r - line / 2 : r + line / 2;
  const dy = y - centre;
  const reach = Math.sqrt(Math.max(0, round * round - dy * dy));
  const dx = -dy / (reach || 1);
  const tx = right ? dx : -dx;
  const length = Math.sqrt(tx * tx + 1);
  return { x: right ? edge - r + reach : edge + r - reach, tx: tx / length, ty: 1 / length, round };
}

/** A body's ring from one height to another, with the arcs where it rounds a corner. */
function alongRing(X: Body, en: Ends, right: boolean, from: number, to: number, line: number): string {
  const way = to > from ? 1 : -1;
  const stops = [from];
  for (const y of [X.o.t + en.top, X.o.b - en.bottom])
    if ((y - from) * way > 0 && (to - y) * way > 0) stops.push(y);
  stops.push(to);
  stops.sort((u, v) => (u - v) * way);
  let d = "";
  for (let i = 1; i < stops.length; i++) {
    const p = pointOn(X, en, right, stops[i]!, line);
    const mid = pointOn(X, en, right, (stops[i - 1]! + stops[i]!) / 2, line);
    d += mid.round
      ? ` A${n2(mid.round)} ${n2(mid.round)} 0 0 0 ${n2(p.x)} ${n2(stops[i]!)}`
      : ` L${n2(p.x)} ${n2(stops[i]!)}`;
  }
  return d;
}
