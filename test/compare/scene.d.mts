/** The data file beside a picture; `scene.mjs` reads it from a page. */

/** What a state is drawn in. The window is in CSS pixels; `scale` is the device's pixels per CSS pixel. */
export interface Variant {
  device: string;
  face: string;
  scheme: "light" | "dark";
  width: number;
  height: number;
  scale: number;
}

/** The values a token carries, as the browser resolved them. */
export interface Drawn {
  color: string;
  backgroundColor: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  borderRadius: string;
  paddingTop: string;
  paddingRight: string;
  paddingBottom: string;
  paddingLeft: string;
  borderColor: string;
}

/**
 * The style a piece of text is drawn in: the nine values every type says, and every other property of the
 * words' list in `paint-properties.json` whose computed value is not its initial one, under the property's
 * own name (`fontVariantNumeric`, `textOverflow`). Plain words say the nine and nothing more.
 */
export interface TextType {
  color: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  fontStyle: string;
  lineHeight: string;
  letterSpacing: string;
  fontVariationSettings: string;
  textTransform: string;
  /** How the words are turned on the screen (`SceneNode.turn`), and the way their line is written when it is not left to right; absent when upright. */
  turn?: string;
  /**
   * The lines under, over and through the words: one entry a box that draws any, nearest first, each its
   * lines, their colour, and what else of them is not plain (`line-through rgb(90, 83, 75)`;
   * `underline rgb(31, 75, 255) thickness 2px underline-offset 3px`). The box that declares a line draws
   * it through the words of the boxes inside it, so it is read there and not on the words' own element.
   */
  textDecoration?: string;
  [listed: string]: string | undefined;
}

/** One row of a list in `paint-properties.json`. */
export interface PaintRow {
  property: string;
  /** A key of the file's `sources`. */
  source: string;
  /** The computed value on an element nothing styled; `currentcolor` where it follows the words' colour. */
  initial?: string;
  said?: "always";
  /** The reading that says the property, when that is not its own name. */
  as?: string;
  /** The listed property that must be set at the same box for this one to paint. */
  with?: string;
  /** A condition `scene.mjs` knows. */
  when?: string;
  /** Words: where the value is read, when not on the element they stand in. */
  from?: "line" | "around" | "decorating";
  /** Words read `around`: the values a box that lays out the line does not say, because they do nothing there. */
  quietOnTheBoxOfTheLine?: string[];
  /** The browser computes the initial value from the box: it is the box's middle, in pixels. */
  initialIsTheMiddleOfTheBox?: boolean;
  note?: string;
}

/** The three lists the reader is handed. */
export interface PaintLists {
  words: PaintRow[];
  boxes: PaintRow[];
  shapes: PaintRow[];
}

/** `paint-properties.json` whole: the lists, and where every other property the browser computes stands. */
export interface PaintFile extends PaintLists {
  about: string[];
  browser: string;
  sources: Record<string, string>;
  /** What a type or a paint says that is no property's own name. */
  keys: Record<string, string>;
  elsewhere: { reading: string; properties: string[] }[];
  notComputed: { property: string; source: string; why: string }[];
  notListed: { group: string; why: string; properties: string[] }[];
}

/** Words the picture shows, in one style; `type` is a row of the scene's `types`; `shown`: what a control shows, its white space as the control draws it. */
export interface Run {
  said: string;
  type: number;
  shown?: true;
}

/**
 * What an element paints, by the property's name: a fill, a border, a shadow, an outline, an icon's `ink`,
 * a placeholder's colour, which picture an `img` `shows`, and every other property of the boxes' list in
 * `paint-properties.json` whose computed value is not its initial one (`clipPath`, `maskImage`, `filter`);
 * `before.` and `after.` name what its two generated boxes paint, and the words they draw say what the
 * words' list says of them. Only what paints
 * is there. An `ink` says each fill and each stroke of the shapes a person sees of the icon once, a stroke
 * with its width, cap and join (and its dashes, where it has any), then the number of those shapes and a
 * digest, in twelve hex digits, of each one's geometry and of where the browser puts it, turned or mirrored:
 * `stroke rgb(18, 16, 14) 1.8px round round; shapes 2 <digest>`. `turn`, `before.turn` and `after.turn`
 * say how the element's box and its two generated boxes are turned (`SceneNode.turn`); an icon's ink says
 * its own.
 */
export type Paint = Record<string, string>;

/** An element that paints, where it sits; `paint` is a row of the scene's `paints`. */
export interface Surface {
  box: [number, number, number, number];
  paint: number;
  /**
   * The boxes a stylesheet draws before and after the element, where they paint: width and height before
   * any turn, in CSS pixels of the picture; ahead of them x and y from the element's corner, when the
   * element holds the box in place.
   */
  parts?: { before?: number[]; after?: number[] };
}

export interface SceneNode {
  role: string;
  name: string;
  /** A heading's level; absent on every other role. */
  level?: number;
  /** x, y, width, height in CSS pixels, from the window's top left. */
  box: [number, number, number, number];
  drawn: Drawn;
  /**
   * How the node is turned on the screen, everything around it folded in: an angle (`45deg`), `mirrored`
   * (left to right, then the angle if any), or `matrix a b c d` for a slant or a squash. Where it is and how
   * large it is drawn are not in it. Absent when it stands upright.
   */
  turn?: string;
  /**
   * The state a person sees the control in, as a screen reader says it, in one order: `checked` or `mixed`,
   * `pressed`, `open`, `expanded` or `collapsed`, `selected`, `current` (`current page`), `disabled`,
   * `invalid`, `read-only`; `value 40 of 0 to 100` for what a control holds that is no words; `filled 8` for
   * a field of discs, which never says its value; `shows its hint` while a field's hint is what shows.
   * Absent when none applies.
   */
  state?: string[];
  /** The words inside the node that no node inside it holds; a field's value, or its hint while that shows, is among them. */
  text?: Run[];
  /** What paints inside the node, itself included, that no node inside it holds. */
  surfaces?: Surface[];
}

/** A font face the page had loaded. */
export interface Face {
  family: string;
  weight: string;
  style: string;
}

export interface Scene {
  /** Which reader wrote the file. Two scenes are compared only when the same one read both. */
  reader: 7;
  variant: Variant;
  page: { scrollWidth: number; clientWidth: number; scrollHeight: number };
  /** The font faces that arrived, sorted. */
  fonts: Face[];
  types: TextType[];
  paints: Paint[];
  nodes: SceneNode[];
  /** The words and the surfaces no node is around. */
  loose: { text: Run[]; surfaces: Surface[] };
}

/** A reference scene as the archive holds it: the scene, and where it came from. */
export interface ReferenceScene extends Scene {
  key: string;
  studioTag: string;
  studioCommit: string;
}

export function readScene(ask: { variant: Variant; lists: PaintLists }): Scene;
