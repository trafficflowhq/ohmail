/**
 * THE REAL-APP MEASURE'S RULES, apart from any browser: the looks it reads, how two readings of one element become
 * rows, and the verdict of a run against the declared list (`declared.json`). `measure.mts` reads the pages;
 * `real.test.ts` holds these rules on made-up readings.
 */

/** A look, named as the comparison's own pictures name one: width, face, scheme. */
export interface Look {
  name: string;
  width: number;
  height: number;
  face: "paper" | "ohmarchy";
  scheme: "light" | "dark";
}

const look = (width: number, height: number, face: Look["face"], scheme: Look["scheme"]): Look => ({
  name: `${width}-${face}-${scheme}`,
  width,
  height,
  face,
  scheme,
});

/** The eight looks: a phone, a desktop and a wide window; paper light and dark at each, ohmarchy dark on the two wide ones. */
export const LOOKS: readonly Look[] = [
  look(1440, 900, "paper", "light"),
  look(1440, 900, "paper", "dark"),
  look(2000, 1240, "paper", "light"),
  look(2000, 1240, "paper", "dark"),
  look(390, 844, "paper", "light"),
  look(390, 844, "paper", "dark"),
  look(1440, 900, "ohmarchy", "dark"),
  look(2000, 1240, "ohmarchy", "dark"),
];

/** Below this width a look is a phone's: a finger, the dock, one column. */
export const PHONE_BELOW = 600;
export const isPhone = (l: Look): boolean => l.width < PHONE_BELOW;

/**
 * The reference's address parameters for a look, in the registry's own names (`registry.json`'s variants): a device,
 * a face and a scheme are said only where they are not the reference's default (desktop, paper, light).
 */
export function lookParams(l: Look): string[] {
  return [
    ...(isPhone(l) ? ["device=phone"] : []),
    ...(l.face === "ohmarchy" ? ["face=ohmarchy"] : []),
    ...(l.scheme === "dark" ? ["scheme=dark"] : []),
  ];
}

export type Kind = "box" | "text" | "icon";

/** One element of a subject: its name, what kind it is, and how each side finds it (null: that side has none). */
export interface Element {
  name: string;
  kind: Kind;
  app: string | null;
  reference: string | null;
  /** Its place is read from this element's corner on both sides, so a shift of the whole counts once, there. */
  in?: string;
  /** A count: its digits are each world's mail, so its words are not compared, and its width only at equal length. */
  count?: true;
  /** It stands beside this count and takes the room the digits leave: its width is compared at equal length only. */
  beside?: string;
}

/** What the browser computed for one element (`page.mjs`), and the face the browser drew its words in. */
export type Reading = Record<string, string | number | boolean | null>;
export type Readings = Record<string, Reading | null>;

/** One difference: the look, the subject, the element, the property, the app's value and the reference's. */
export interface Row {
  look: string;
  subject: string;
  element: string;
  property: string;
  app: string;
  reference: string;
}

/** The properties each kind of element is compared on. */
export const COMPARED: Record<Kind, readonly string[]> = {
  box: ["x", "y", "w", "h", "background", "radius", "border", "shadow", "padding", "gap", "opacity"],
  text: ["text", "x", "y", "w", "h", "face", "fontFamily", "fontWeight", "fontSize", "lineHeight", "letterSpacing", "fontVariation", "color", "background", "padding"],
  icon: ["x", "y", "w", "h", "viewBox", "strokeWidth", "stroke", "fill", "iconColor"],
};

/** A box's edges and size are numbers within the comparison's box tolerance; every other value is a string, equal or not. */
const BOX = new Set(["x", "y", "w", "h"]);
const shown = (v: unknown): string => (v === null || v === undefined ? "-" : String(v));
const lengthOf = (r: Reading | null | undefined): number => shown(r?.text).length;

/**
 * Every difference between the two sides' readings of a subject's elements at one look. An element on neither side
 * is no row; on one side only, one row (`present`), unless the side that has it does not draw it; drawn on one side
 * and hidden on the other, one row (`visible`). Otherwise one row a compared property that differs: a box's
 * edges and size by more than `box` CSS pixels, any other value by its computed string.
 */
export function differ(
  at: { look: string; subject: string },
  elements: readonly Element[],
  app: Readings,
  reference: Readings,
  box: number,
): Row[] {
  const rows: Row[] = [];
  const row = (element: string, property: string, a: unknown, r: unknown) =>
    rows.push({ ...at, element, property, app: shown(a), reference: shown(r) });
  for (const el of elements) {
    let a = app[el.name] ?? null;
    let r = reference[el.name] ?? null;
    if (!a && !r) continue;
    if (!a || !r) {
      if ((a ?? r)!.visible === true) row(el.name, "present", a ? "yes" : "no", r ? "yes" : "no");
      continue;
    }
    if (a.visible !== r.visible) {
      row(el.name, "visible", a.visible, r.visible);
      continue;
    }
    if (a.visible !== true) continue;
    const aIn = el.in ? app[el.in] : null;
    const rIn = el.in ? reference[el.in] : null;
    if (aIn && rIn) {
      a = { ...a, x: Number(a.x) - Number(aIn.x), y: Number(a.y) - Number(aIn.y) };
      r = { ...r, x: Number(r.x) - Number(rIn.x), y: Number(r.y) - Number(rIn.y) };
    }
    const count = el.count ? el : el.beside ? elements.find((e) => e.name === el.beside) : undefined;
    const digitsDiffer = !!count && lengthOf(app[count.name]) !== lengthOf(reference[count.name]);
    for (const property of COMPARED[el.kind]) {
      if (el.count && property === "text") continue;
      if (digitsDiffer && (property === "w" || (el.count && property === "x"))) continue;
      const av = a[property];
      const rv = r[property];
      if (BOX.has(property)) {
        if (Math.abs(Number(av) - Number(rv)) > box + 1e-6) row(el.name, property, Math.round(Number(av) * 10) / 10, Math.round(Number(rv) * 10) / 10);
      } else if (shown(av) !== shown(rv)) row(el.name, property, av, rv);
    }
  }
  return rows;
}

/** A row of `declared.json`: differences that are meant for now, the reason, and the task that removes them. */
export interface Declared {
  subject: string;
  reason: string;
  since: string;
  /** The task whose landing makes these rows go. */
  removedBy: string;
  /** `app`: the app's value the row was declared at; a row whose value is another is undeclared. */
  rows: DeclaredRow[];
}

export interface DeclaredRow {
  element: string;
  property: string;
  looks: string[];
  app?: string;
}

const tuple = (look: string, subject: string, element: string, property: string): string =>
  JSON.stringify([look, subject, element, property]);

/** What a row can name: one of the eight looks, and a property some kind of element is compared on. */
const LOOK_NAMES = new Set(LOOKS.map((l) => l.name));
const PROPERTIES = new Set(["present", "visible", ...Object.values(COMPARED).flat()]);

export interface Verdict {
  green: boolean;
  /** Rows the list does not declare. */
  undeclared: Row[];
  /** Declared rows of a measured look and subject that no longer occur: the list only shrinks, so they leave it. */
  gone: { look: string; subject: string; element: string; property: string; removedBy: string }[];
  /** Rows the list declares, each with its task. */
  declared: (Row & { removedBy: string })[];
  /** What is wrong with the list itself: an entry without its reason or task, a row named twice, a row naming a look or property never read. */
  faults: string[];
}

/**
 * The run's verdict. `measured` names the looks of each subject that were read: a declared row of a look not read
 * is not judged. GREEN: every row declared, every declared row of what was read still occurring, and a sound list.
 */
export function verdict(rows: readonly Row[], list: readonly Declared[], measured: readonly { subject: string; look: string }[]): Verdict {
  const faults: string[] = [];
  const declaredBy = new Map<string, { removedBy: string; app: string | undefined }>();
  for (const [i, entry] of list.entries()) {
    for (const field of ["subject", "reason", "since", "removedBy"] as const) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") faults.push(`declared.json entry ${i}: no ${field}`);
    }
    for (const r of entry.rows ?? []) {
      /* A row that could never occur would never be reported gone, and would stay in the list for good. */
      if (!PROPERTIES.has(r.property)) faults.push(`declared.json: ${entry.subject} ${r.element} ${r.property}: no element is compared on that property`);
      for (const l of r.looks) {
        if (!LOOK_NAMES.has(l)) faults.push(`declared.json: ${l} ${entry.subject} ${r.element} ${r.property}: no such look`);
        const key = tuple(l, entry.subject, r.element, r.property);
        if (declaredBy.has(key)) faults.push(`declared.json: ${l} ${entry.subject} ${r.element} ${r.property} is declared twice`);
        declaredBy.set(key, { removedBy: entry.removedBy, app: r.app });
      }
    }
  }
  const seen = new Set<string>();
  const undeclared: Row[] = [];
  const declared: Verdict["declared"] = [];
  for (const row of rows) {
    const key = tuple(row.look, row.subject, row.element, row.property);
    seen.add(key);
    const held = declaredBy.get(key);
    /* A row declared at one value of the app's and read at another is a second change: not declared. */
    if (held === undefined || (held.app !== undefined && held.app !== row.app)) undeclared.push(row);
    else declared.push({ ...row, removedBy: held.removedBy });
  }
  const read = new Set(measured.map((m) => JSON.stringify([m.look, m.subject])));
  const gone: Verdict["gone"] = [];
  for (const [key, { removedBy }] of declaredBy) {
    const [l, subject, element, property] = JSON.parse(key) as [string, string, string, string];
    if (read.has(JSON.stringify([l, subject])) && !seen.has(key)) gone.push({ look: l, subject, element, property, removedBy });
  }
  return { green: undeclared.length === 0 && gone.length === 0 && faults.length === 0, undeclared, gone, declared, faults };
}

/**
 * Rows not declared yet, in `declared.json`'s own form: one entry a subject, its reason and task to be written; one
 * row an element, property and app's value.
 */
export function asDeclared(rows: readonly Row[], since: string): Declared[] {
  const bySubject = new Map<string, Map<string, DeclaredRow>>();
  for (const r of rows) {
    const subject = bySubject.get(r.subject) ?? new Map<string, DeclaredRow>();
    bySubject.set(r.subject, subject);
    const key = JSON.stringify([r.element, r.property, r.app]);
    const entry = subject.get(key) ?? { element: r.element, property: r.property, looks: [], app: r.app };
    subject.set(key, entry);
    entry.looks.push(r.look);
  }
  return [...bySubject].map(([subject, entries]) => ({ subject, reason: "", since, removedBy: "", rows: [...entries.values()] }));
}
