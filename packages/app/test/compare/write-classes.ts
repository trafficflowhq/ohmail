/**
 * THE NAMED CLASSES a row of `write-declared.json` may stand in, each a difference from the design a person can check
 * against it. A difference of no class is a difference to mend, in the screen or as an ask of the kit, never a row.
 */
export const WRITE_CLASSES = {
  posture:
    "a posture of a folding phone: the states page stands a window, never a posture; the phone shell's (phone-touch)",
  "after-the-press":
    "the letter has left the reading column: what stands is the frame's report and another place's list, none of it write's",
  "kit-ask": "a part the kit lacks, drawn with a stand-in until the kit's ask lands (named in the reason)",
  "shipped-name":
    "a control keeps the name 1.0.11 gives it (what the journeys and a screen reader find), where the reference names it anew",
} as const;

export type WriteClass = keyof typeof WRITE_CLASSES;

/** The parts of the letter the comparison holds, each by its node's box on both sides. */
export const WRITE_PARTS = [
  "status",
  "head",
  "marks",
  "tabs",
  "text",
  "signature",
  "files",
  "notes",
  "foot",
  "verbs",
  "over",
] as const;
export type WritePart = (typeof WRITE_PARTS)[number];

/** A row of `write-declared.json`. */
export interface WriteDeclaredRow {
  keys: string[];
  class: WriteClass;
  reason: string;
  since: string;
  removedBy: string;
  out?: { role: string; name: string }[];
  unnamed?: { role: string; name: string }[];
  pairs?: { role: string; name: string; as: string; asRole?: string }[];
  notDrawn?: WritePart[] | "state";
}
