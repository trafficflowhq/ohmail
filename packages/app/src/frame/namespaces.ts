/** The catalogue namespaces the frame reads. A value only: the web's first screen imports it with no React. */
export const FRAME_NAMESPACES = ["frame"] as const;
export type FrameNamespace = (typeof FRAME_NAMESPACES)[number];

/**
 * The frame's sentences on its first frame at rest, over today's wide body with no notice standing: the landmarks'
 * names, the handle's, the dock's three and a counted entry's. The web's first screen inlines these alone, so the frame
 * is never drawn without its words; the rest of its namespace arrives with the catalogue.
 */
export const FRAME_AT_REST = [
  "landmark.fedRail",
  "landmark.places",
  "landmark.stage",
  "columns.railWidth",
  "dock.more",
  "dock.search",
  "dock.write",
  "rail.counted",
] as const;
