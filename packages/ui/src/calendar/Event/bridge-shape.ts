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
  /** One painted pixel on the boxes’ coordinate scale. */
  pixel?: number;
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
const STRAIGHT = 20;
/** How far round a corner it may attach, in degrees: a side leaves the edge at 35° at most. */
const ARC = 55;
/** The widest gap it crosses. */
const GAP = 40;
const LAP = 3;
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
  cutTop: boolean;
  cutBottom: boolean;
}
interface Point {
  x: number;
  tx: number;
  ty: number;
  round?: number;
}

const coordinate = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * The bridge between an open event and its card, or `null` where it lets go: the card on its event,
 * a gap wider than 40 px, less than 10 px of edge in common, a hinge between two screens in the way.
 * It is drawn whole or not at all.
 */
export function bridgeShape({
  event,
  card,
  side,
  line,
  pixel,
  marks = [],
  hinge,
}: BridgeInput): BridgeShape | null {
  if (side === "o") return null;
  const turned = side === "t" || side === "b";
  const frame = (box: BridgeBox) => frameOf(box, turned, pixel);
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
  const limit = (ends: Ends, radius: number, cut: boolean) => Math.max(radius, ends.half, cut ? LAP + 1 : 0);
  const band = (round: number): [number, number] => [
    Math.max(L.o.t + limit(eL, eL.top * round, eL.cutTop), R.o.t + limit(eR, eR.top * round, eR.cutTop)),
    Math.min(
      L.o.b - limit(eL, eL.bottom * round, eL.cutBottom),
      R.o.b - limit(eR, eR.bottom * round, eR.cutBottom),
    ),
  ];
  const obstacles = marks.map(frame);
  const low = Math.min(L.o.r, R.o.l),
    high = Math.max(L.o.r, R.o.l);
  const flat = partOf(band(1), obstacles, low, high);
  const part = flat && flat[1] - flat[0] >= STRAIGHT ? flat : partOf(band(least), obstacles, low, high);
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

  const lapped = (X: Body, at: number, above: boolean): number =>
    above ? Math.min(at, Math.max(at - LAP, X.o.t + 0.5)) : Math.max(at, Math.min(at + LAP, X.o.b - 0.5));
  const step = pixel ?? 1;
  const pad = line / 2 + 1;
  const intoLeft = coordinate(Math.floor((Math.min(near1.x, near2.x) - pad) / step) * step);
  const intoRight = coordinate(Math.ceil((Math.max(far1.x, far2.x) + pad) / step) * step);

  const formOf = (pull: number): BridgeForm => {
    const handle = (point: Point, gap: number) =>
      point.tx ? Math.min(pull, (0.45 * gap) / Math.abs(point.tx)) : pull;
    const curve = (u: Point, v: Point, y: number, direction: number) => {
      const gap = Math.abs(v.x - u.x);
      const a = handle(u, gap) * direction;
      const b = handle(v, gap) * direction;
      return ` C${coordinate(u.x + a * u.tx)} ${coordinate(y + a * u.ty)} ${coordinate(v.x + b * v.tx)} ${coordinate(y + b * v.ty)} ${coordinate(v.x)} ${coordinate(y)}`;
    };
    const top = curve(near1, far1, y1, 1);
    const bottom = curve(far2, near2, y2, -1);
    const inset = pull === 0 ? line / 2 : 0;
    const start = coordinate(y1 + inset);
    const end = coordinate(y2 - inset);
    const fill = `M${intoLeft} ${start} H${coordinate(near1.x)} L${coordinate(near1.x)} ${coordinate(y1)}${top} V${start} H${intoRight} V${end} H${coordinate(far2.x)} V${coordinate(y2)}${bottom} V${end} H${intoLeft} Z`;
    const lt = lapped(L, y1, true);
    const rt = lapped(R, y1, true);
    const lb = lapped(L, y2, false);
    const rb = lapped(R, y2, false);
    return {
      fill,
      sides: [
        `M${coordinate(point(L, eL, true, lt).x)} ${coordinate(lt)}${along(L, eL, true, lt, y1)}${top}${along(R, eR, false, y1, rt)}`,
        `M${coordinate(point(R, eR, false, rb).x)} ${coordinate(rb)}${along(R, eR, false, rb, y2)}${bottom}${along(L, eL, true, y2, lb)}`,
      ],
    };
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
    turned,
    top: y1,
    bottom: y2,
    from: coordinate(atEvent),
    to: coordinate(atCard),
    meets,
    root: swap(atEvent, middle),
    middle: swap(atCard, middle),
  };
}

function frameOf(box: BridgeBox, turned: boolean, pixel?: number): Frame {
  const snap = (value: number) => (pixel ? Math.round(value / pixel) * pixel : value);
  const left = snap(box.left);
  const right = snap(box.right);
  const top = snap(box.top);
  const bottom = snap(box.bottom);
  return turned ? { l: top, r: bottom, t: left, b: right } : { l: left, r: right, t: top, b: bottom };
}

/* A corner the scroll cut away is no corner: that end is straight. */
function endsOf(X: Body, line: number): Ends {
  const r = Math.min(X.radius, (X.real.b - X.real.t) / 2, (X.real.r - X.real.l) / 2);
  const cutTop = Math.abs(X.o.t - X.real.t) > 0.5;
  const cutBottom = Math.abs(X.o.b - X.real.b) > 0.5;
  return {
    top: cutTop ? 0 : r,
    bottom: cutBottom ? 0 : r,
    cutTop,
    cutBottom,
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
  if (from === to) return "";
  const sweep = right === way > 0 ? 1 : 0;
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
      ? ` A${coordinate(mid.round)} ${coordinate(mid.round)} 0 0 ${sweep} ${coordinate(p.x)} ${coordinate(stops[i]!)}`
      : ` L${coordinate(p.x)} ${coordinate(stops[i]!)}`;
  }
  return d;
}
