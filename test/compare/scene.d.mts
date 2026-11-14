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

/** The style a piece of text is drawn in. */
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
}

/** Words the picture shows, in one style; `type` is a row of the scene's `types`. */
export interface Run {
  said: string;
  type: number;
}

/**
 * What an element paints, by the property's name: a fill, a border, a shadow, an outline, an icon's `ink`,
 * a placeholder's colour; `before.` and `after.` name what its two generated boxes paint. Only what paints
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
  /** The words inside the node that no node inside it holds. */
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
  reader: 5;
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

export function readScene(variant: Variant): Scene;
