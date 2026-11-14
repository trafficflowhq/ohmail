/**
 * HOW WRITE'S PARTS ARE CUT out of a scene, and how the declared rows apply to both sides: pure functions of the two
 * scenes, read by the comparison (`write-parts.compare.ts`) and by any reading of scenes drawn elsewhere.
 */
import type { Scene, SceneNode } from "../../../../test/compare/scene.d.mts";
import { cutScene } from "../../../ui/test/compare/cut.mjs";
import { WRITE_PARTS, type WriteDeclaredRow, type WritePart } from "./write-classes.js";

export type Box = [number, number, number, number];
type PartName = WritePart;
const PARTS: readonly PartName[] = WRITE_PARTS;
type DeclaredRow = WriteDeclaredRow;

export const inside = (box: number[], at: number[], slack = 0.5): boolean =>
  box[0]! >= at[0]! - slack &&
  box[1]! >= at[1]! - slack &&
  box[0]! + box[2]! <= at[0]! + at[2]! + slack &&
  box[1]! + box[3]! <= at[1]! + at[3]! + slack;
export const union = (boxes: number[][]): Box => {
  const x = Math.min(...boxes.map((b) => b[0]!)),
    y = Math.min(...boxes.map((b) => b[1]!));
  const r = Math.max(...boxes.map((b) => b[0]! + b[2]!)),
    d = Math.max(...boxes.map((b) => b[1]! + b[3]!));
  return [x, y, r - x, d - y];
};

/**
 * A scene with the nodes `gone` names left out as nodes: what they hold of words and paint stands loose, as where no
 * node stands at all (a landmark the reference does not name holds the words and paint the reference holds loose).
 */
function lessNodes(s: Scene, gone: (n: SceneNode) => boolean): Scene {
  const out = s.nodes.filter(gone);
  return {
    ...s,
    nodes: s.nodes.filter((n) => !gone(n)),
    loose: {
      text: [...s.loose.text, ...out.flatMap((n) => n.text ?? [])],
      surfaces: [...s.loose.surfaces, ...out.flatMap((n) => n.surfaces ?? [])],
    },
  };
}

/** The declared rows applied: a row's nodes left out of both sides, its pairs read on the reference's side. */
export function declaredOn(
  rows: readonly DeclaredRow[],
  key: string,
  reference: Scene,
  actual: Scene,
): { reference: Scene; actual: Scene } {
  const holds = (s: Scene, role: string, name: string) =>
    s.nodes.some((n) => n.role === role && n.name === name);
  for (const d of rows) {
    const bites =
      d.notDrawn !== undefined ||
      d.out?.some((o) => holds(reference, o.role, o.name) || holds(actual, o.role, o.name)) ||
      d.unnamed?.some((o) => holds(actual, o.role, o.name)) ||
      d.pairs?.some((p) => holds(reference, p.role, p.name));
    if (!bites) throw new Error(`${key}: the declared row "${d.reason}" names nothing either side holds`);
  }
  const named = (list: "out" | "unnamed") => (n: SceneNode) =>
    rows.some((d) => d[list]?.some((o) => o.role === n.role && o.name === n.name));
  const gone = named("out");
  const loose = named("unnamed");
  const without = (s: Scene): Scene => lessNodes({ ...s, nodes: s.nodes.filter((n) => !gone(n)) }, loose);
  const less = without(reference);
  return {
    reference: {
      ...less,
      nodes: less.nodes.map((n) => {
        const pair = rows.flatMap((d) => d.pairs ?? []).find((p) => p.role === n.role && p.name === n.name);
        return pair ? { ...n, name: pair.as, role: pair.asRole ?? n.role } : n;
      }),
    },
    actual: without(actual),
  };
}

/** A part as each side holds it: the scene cut to its box, and the box its picture is held by. */
export interface Part {
  scene: Scene;
  box: Box;
  nodes: SceneNode[];
  /** Its nodes' boxes are from its own corner. */
  fromCorner: boolean;
}

const only = (s: Scene, box: Box, place: "window" | "block" = "block"): Part => {
  const cut = cutScene(s, box, place);
  return {
    scene: { ...cut, loose: { text: [], surfaces: cut.loose.surfaces } },
    box,
    nodes: cut.nodes,
    fromCorner: place !== "window",
  };
};

/** The reading column: right of the list's handle; on a phone, with no list beside it, the window. */
function readingOf(s: Scene): Box {
  const { width, height } = s.variant;
  const handle = s.nodes.find((n) => n.role === "separator" && n.name === "List width");
  if (!handle) return [0, 0, width, height];
  const x = handle.box[0] + handle.box[2];
  return [x, 0, width - x, height];
}

const OVER = new Set(["menu", "dialog", "listbox"]);
const named = (n: SceneNode, role: string, name: string | RegExp): boolean =>
  n.role === role && (typeof name === "string" ? n.name === name : name.test(n.name));

/** Every part of one side, in its order on the page. */
export function partsOf(s: Scene): Map<PartName, Part[]> {
  const parts = new Map<PartName, Part[]>(PARTS.map((p) => [p, []]));
  const col = readingOf(s);
  const here = s.nodes.filter((n) => inside(n.box, col, 8) && !OVER.has(n.role));
  const find = (role: string, name: string | RegExp) => here.find((n) => named(n, role, name));
  for (const o of s.nodes.filter((n) => OVER.has(n.role)))
    parts.get("over")!.push(only(s, o.box as Box, "window"));
  const subject = find("textbox", "Subject");
  const text = find("textbox", "Message");
  const to = find("textbox", "To") ?? find("combobox", "To");
  const top = to ?? subject;
  /* The From line stands one line over the first people's line. */
  const headTop = top ? top.box[1] - 40 : null;
  if (subject && headTop !== null)
    parts
      .get("head")!
      .push(only(s, [col[0], headTop, col[2], subject.box[1] + subject.box[3] - headTop], "window"));
  for (const st of here.filter((n) => n.role === "status")) {
    const over = headTop !== null && st.box[1] < headTop + 8;
    parts.get(over ? "status" : "notes")!.push(only(s, st.box as Box));
  }
  const marks = find("toolbar", "Formatting");
  if (marks) parts.get("marks")!.push(only(s, marks.box as Box));
  const tabs = find("group", "The text");
  if (tabs) parts.get("tabs")!.push(only(s, tabs.box as Box));
  if (text) parts.get("text")!.push(only(s, text.box as Box));
  /* Found by what they hold, not by their names: a name that differs is the names question's to say, inside the part. */
  const sig = here.filter(
    (n) => named(n, "textbox", /^Signature/) || named(n, "button", /^Remove signature/),
  );
  if (sig.length > 0) parts.get("signature")!.push(only(s, union(sig.map((n) => n.box))));
  const below = text ? text.box[1] + text.box[3] : 0;
  const files = here.filter(
    (n) =>
      n.box[1] >= below &&
      (named(n, "button", /^(Preview|Remove) /) || named(n, "heading", /./)) &&
      !n.name.startsWith("Remove signature"),
  );
  if (files.length > 0) parts.get("files")!.push(only(s, union(files.map((n) => n.box))));
  const holding = (bar: SceneNode, name: RegExp) =>
    s.nodes.some((n) => n.role === "button" && name.test(n.name) && inside(n.box, bar.box, 1));
  const bars = s.nodes.filter((n) => n.role === "toolbar");
  const foot = bars.find((b) => holding(b, /^Attach/));
  if (foot) parts.get("foot")!.push(only(s, foot.box as Box));
  const verbs = bars.find((b) => holding(b, /^(Send|Sending)$/));
  if (verbs) parts.get("verbs")!.push(only(s, verbs.box as Box, "window"));
  return parts;
}
