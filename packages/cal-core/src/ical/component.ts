/**
 * Calendar text as a tree: components holding properties and components, in the order written.
 * Nothing is interpreted here: a property, a parameter or a component this package has no word for
 * is kept as it stands, so that reading and writing a calendar loses nothing. The typed views
 * (`event`, `calendar`) read from this tree and edit it one line at a time.
 *
 * One thing is left out, and said: an event whose UID, zone name or block name is longer than its
 * kind may be (`limits`, "a stranger's strings, by kind"). This is the one place a stranger's text
 * comes in, so the ceilings on its strings are held here, and nothing made from the tree handles a
 * longer one.
 */
import { MAX_NAME_CHARS, MAX_UID_CHARS, MAX_ZONE_NAME_CHARS, type Limits } from "../limits.js";
import { countLines, countParts, fold, formatContentLine, sameName, scanContentLine, unfold } from "./lines.js";

export interface Param {
  /** As written. No longer than a name may be (`MAX_NAME_CHARS`). */
  readonly name: string;
  /**
   * The values, unquoted and with RFC 6868's carets decoded. Empty for a parameter written with no
   * `=`, and for one whose text is longer than a parameter's may be (`MAX_PARAM_VALUE_CHARS`): that
   * one is read as nothing, and `raw` still writes it back whole.
   */
  readonly values: readonly string[];
  /** The text after `=` as written, quotes included: what a write puts back. */
  readonly raw: string;
  /** A parameter written with no `=` at all. */
  readonly bare?: true;
}

export interface Property {
  /** As written; compared without regard to case. Empty for a line that is not a content line (kept, never read). */
  readonly name: string;
  readonly params: readonly Param[];
  /** The value as written, escapes and all. What it means is the reader's question per property. */
  readonly value: string;
  /** Set when the property was written after this many of its component's sub-components, which the grammar does not expect. */
  readonly afterComponents?: number;
}

export interface Component {
  readonly name: string;
  readonly properties: readonly Property[];
  readonly components: readonly Component[];
}

/**
 * The ceiling a string broke, by its kind: a component's name, a UID, a zone's name. The same word
 * names an event that was left out for it and a text that was refused for it.
 */
export type StringBreach = "name_too_long" | "uid_too_long" | "zone_name_too_long";

/** Why a text was not read. */
export type ReadRefusal = "not_a_calendar" | "too_large" | "too_many_lines" | "too_many_parts" | "line_too_long" | "too_many_parameters" | "too_many_components" | "too_deep" | "unbalanced" | StringBreach;

/**
 * A component the reader left out, with everything inside it: one of a calendar's own (an event, a
 * task, a zone definition) that holds a string longer than its kind may be.
 */
export interface DroppedComponent {
  /** The component's name as written (`VEVENT`); empty when its own name is what was too long. */
  readonly name: string;
  readonly reason: StringBreach;
}

/**
 * `dropped`: what was left out of `components`, in the order written. A text read with something
 * left out is not the text that was written: it is shown, and never written back in its place.
 */
export type ParsedComponents = { readonly ok: true; readonly components: readonly Component[]; readonly dropped: readonly DroppedComponent[] } | { readonly ok: false; readonly reason: ReadRefusal };

interface Open {
  name: string;
  properties: Property[];
  components: Component[];
  /** Set on a calendar's own component when a string in it, at whatever depth, broke its ceiling. */
  spoilt?: StringBreach;
}

/**
 * The ceiling a property's strings break, by their kinds, or `null`: its value where it is a UID or
 * a zone definition's name, and what its TZID parameter holds. They are found as the typed views
 * find them (`propertyOf`, `paramOf`), so whatever a view reads, this has measured.
 */
function breachOf(p: Property): StringBreach | null {
  // A name that reads as UID or TZID has no more characters than they have.
  if (p.name.length <= 4) {
    if (p.value.length > MAX_UID_CHARS && sameName(p.name, "UID")) return "uid_too_long";
    if (p.value.length > MAX_ZONE_NAME_CHARS && sameName(p.name, "TZID")) return "zone_name_too_long";
  }
  for (const param of p.params) {
    // Only a parameter with a value longer than a zone's name, or with more text than a parameter may have (no value is made of that one), is asked what it is.
    if (param.bare) continue;
    let within = param.values.length > 0;
    for (let n = 0; within && n < param.values.length; n++) within = param.values[n]!.length <= MAX_ZONE_NAME_CHARS;
    if (within) continue;
    const name = param.name.trim();
    if (name.length <= 4 && sameName(name, "TZID")) return "zone_name_too_long";
  }
  return null;
}

/**
 * Every top-level component of a text. Refuses, with a word and never by throwing: a text past its
 * ceilings, a BEGIN that is never ended or an END that ends something else, and a text with no
 * component in it at all. Lines outside any component are not kept. The ceilings on lines, on the
 * parts of the whole text and on the parameters of a line are counted before anything is made of
 * them: the tree holds an object for each, many times the size of the text it came from.
 *
 * The strings have their ceilings by kind (`limits`). A line's own name and its parameters are held
 * by the scan of the line, which loses nothing. A component's name, a UID and a zone's name cannot
 * be kept and not read: an event with no UID is a series of its own, a time with no zone is another
 * time, and the lines of a block with no name would fall to the block around it. One of those past
 * its ceiling spoils what it stands in:
 *
 *   - inside one of a calendar's own components (an event, a zone definition), at whatever depth:
 *     that component is left out whole, and `dropped` names it. The rest of the calendar reads.
 *   - in a top-level component's own lines, or as its name: there is nothing to leave out but the
 *     calendar, and the text is refused by the same word.
 */
export function parseComponents(text: string, limits: Limits): ParsedComponents {
  if (typeof text !== "string" || text.length === 0) return { ok: false, reason: "not_a_calendar" };
  if (text.length > limits.maxTextChars) return { ok: false, reason: "too_large" };
  // Counted on the text itself: what is refused here is never held as lines or as objects.
  if (countLines(text, limits.maxLines) > limits.maxLines) return { ok: false, reason: "too_many_lines" };
  if (countParts(text, limits.maxParams, limits.maxParts) > limits.maxParts) return { ok: false, reason: "too_many_parts" };
  const done: Component[] = [];
  const dropped: DroppedComponent[] = [];
  const stack: Open[] = [];
  let count = 0;
  /** The calendar's own component the line being read stands in is spoilt; `false` when the line stands in no such component, and the text is refused. */
  const spoil = (breach: StringBreach): boolean => {
    const own = stack[1];
    if (own === undefined) return false;
    own.spoilt ??= breach;
    return true;
  };
  for (const line of unfold(text)) {
    if (line.length > limits.maxLineChars) return { ok: false, reason: "line_too_long" };
    const parsed = scanContentLine(line, limits.maxParams);
    if (parsed === "too_many_parameters") return { ok: false, reason: parsed };
    const keyword = parsed === null || parsed.params.length > 0 ? "" : parsed.name.trim().toUpperCase();
    if (keyword === "BEGIN") {
      if (++count > limits.maxComponents) return { ok: false, reason: "too_many_components" };
      if (stack.length >= limits.maxDepth) return { ok: false, reason: "too_deep" };
      // The name is held while the block is open, to know its END by; past its ceiling it goes no further than that.
      const name = parsed!.value.trim();
      stack.push({ name, properties: [], components: [] });
      if (name.length > MAX_NAME_CHARS && !spoil("name_too_long")) return { ok: false, reason: "name_too_long" };
      continue;
    }
    const top = stack[stack.length - 1];
    if (keyword === "END") {
      if (top === undefined || !sameName(top.name, parsed!.value.trim())) return { ok: false, reason: "unbalanced" };
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent === undefined) done.push(top);
      else if (stack.length === 1 && top.spoilt !== undefined) dropped.push({ name: top.name.length > MAX_NAME_CHARS ? "" : top.name, reason: top.spoilt });
      else if (stack[1]?.spoilt === undefined) parent.components.push(top);
      continue;
    }
    // Nothing more is made of a component that is left out; its lines are still read for where it ends.
    if (top === undefined || stack[1]?.spoilt !== undefined) continue;
    const breach = parsed === null ? null : breachOf(parsed);
    if (breach !== null) {
      if (!spoil(breach)) return { ok: false, reason: breach };
      continue;
    }
    const property: Property = parsed ?? { name: "", params: [], value: line };
    top.properties.push(top.components.length > 0 ? { ...property, afterComponents: top.components.length } : property);
  }
  if (stack.length > 0) return { ok: false, reason: "unbalanced" };
  if (done.length === 0) return { ok: false, reason: "not_a_calendar" };
  return { ok: true, components: done, dropped };
}

/** Why a tree was not written. */
export type WriteRefusal = "control_character";

export type Written = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: WriteRefusal };

/**
 * What a content line may not hold (RFC 5545 section 3.1, CONTROL): every control character but the
 * tab. A line break is two of them, and inside a name, a parameter or a value it would end the line
 * and begin another: a link or an address handed in with one would write an invitee nobody set.
 */
const NOT_IN_A_LINE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/**
 * A component as text: CRLF line ends, lines folded at 75 octets, everything in the order it is
 * held. Refused by word, and never by throwing, when any line of it holds a control character:
 * this is the one place text leaves the package, so it holds for a tree built by hand as for one
 * the builders made. Text and parameter values that go through `escapeText` and `makeParam` carry
 * their line breaks escaped and are written. A text that was read with a control character in it is
 * refused as well: what to do with it is the caller's to decide.
 */
export function writeComponent(c: Component): Written {
  const out: string[] = [];
  emit(c, out);
  if (out.some((line) => NOT_IN_A_LINE.test(line))) return { ok: false, reason: "control_character" };
  return { ok: true, text: out.map((line) => `${fold(line)}\r\n`).join("") };
}

function emit(c: Component, out: string[]): void {
  out.push(`BEGIN:${c.name}`);
  // Properties by the number of sub-components written before them; one past the last sub-component still writes.
  const late = new Map<number, Property[]>();
  for (const p of c.properties) {
    if (!p.afterComponents) out.push(formatContentLine(p));
    else {
      const at = Math.min(p.afterComponents, c.components.length);
      const held = late.get(at);
      if (held === undefined) late.set(at, [p]);
      else held.push(p);
    }
  }
  for (const p of late.get(0) ?? []) out.push(formatContentLine(p));
  c.components.forEach((child, i) => {
    emit(child, out);
    for (const p of late.get(i + 1) ?? []) out.push(formatContentLine(p));
  });
  out.push(`END:${c.name}`);
}

/* ── reading the tree ───────────────────────────────────────────────────────────────────────────── */

export const propertiesOf = (c: Component, name: string): Property[] => c.properties.filter((p) => sameName(p.name, name));
export const propertyOf = (c: Component, name: string): Property | null => c.properties.find((p) => sameName(p.name, name)) ?? null;
export const componentsOf = (c: Component, name: string): Component[] => c.components.filter((k) => sameName(k.name, name));

/* ── editing the tree: a new tree that differs in the one place named ───────────────────────────── */

/**
 * The component with its first property of this name replaced, where it stands; added at the end of
 * the properties when there is none; with `null`, every property of the name taken out. Nothing else
 * is touched, so a write differs from the text that was read in that line alone.
 */
export function withProperty(c: Component, name: string, next: Property | null): Component {
  const at = c.properties.findIndex((p) => sameName(p.name, name));
  if (next === null) return at < 0 ? c : { ...c, properties: c.properties.filter((p) => !sameName(p.name, name)) };
  if (at < 0) return { ...c, properties: [...c.properties, next] };
  const kept = c.properties[at]!.afterComponents;
  const placed = kept === undefined ? next : { ...next, afterComponents: kept };
  return { ...c, properties: c.properties.map((p, i) => (i === at ? placed : p)) };
}

/** The component with one of its properties (this very object) replaced or, with `null`, taken out. */
export function withPropertyAt(c: Component, old: Property, next: Property | null): Component {
  if (!c.properties.includes(old)) return c;
  return { ...c, properties: next === null ? c.properties.filter((p) => p !== old) : c.properties.map((p) => (p === old ? next : p)) };
}

/** The component with one of its sub-components (this very object) replaced or, with `null`, taken out. */
export function withComponent(c: Component, old: Component, next: Component | null): Component {
  if (!c.components.includes(old)) return c;
  return { ...c, components: next === null ? c.components.filter((k) => k !== old) : c.components.map((k) => (k === old ? next : k)) };
}
