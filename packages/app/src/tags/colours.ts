import { design } from "@ohmail/ui/base";

/** The colours a stored tag may take, in the order the picker offers them. */
export const TAG_COLOURS = [
  { id: "rosewood", hue: 25 },
  { id: "ochre", hue: 78 },
  { id: "olive", hue: 112 },
  { id: "moss", hue: 150 },
  { id: "verdigris", hue: 182 },
  { id: "denim", hue: 214 },
  { id: "indigo", hue: 250 },
  { id: "iris", hue: 288 },
  { id: "mulberry", hue: 320 },
  { id: "heather", hue: 352 },
] as const;

const hues = new Map<string, number>(Object.entries(design.tagHues));
for (const colour of TAG_COLOURS) hues.set(colour.id, colour.hue);

/** Older tags can still name a colour from the rail's original palette. */
export function tagHue(name: string): number {
  return hues.get(name) ?? design.tagHues.moss;
}
