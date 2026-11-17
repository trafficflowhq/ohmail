// What a host's entry mounts on the new shell, read from the tree as text: the places seated in the mail's one
// record, the stages and the Settings panes the mail hands, and what its supplies hand the frame beside them (the
// reader, the ground above the places, the calendar). Nothing is run. Where a file of the mail entry is not in
// the tree, nothing of its kind is mounted, and that is said in one line.
import { closeOf, entriesAt, readSource } from "./source-text.mjs";

export const MAIL = "packages/app/src/mail/";
export const PLACES_FILE = `${MAIL}places.ts`;
export const SUPPLIES_FILE = `${MAIL}supplies.ts`;
const FRAME_CONTRACT = "packages/app/src/frame/contract.ts";
const SETTINGS_CONTRACT = "packages/app/src/settings/contract.ts";
/** What a value says when the entry hands nothing there. */
const NOTHING = /^(NONE|none)\b/;

/** The ids of `export const <name> = [ ... ]` in a file's text, or null where it has none. */
export function idsIn(text, name) {
  const reading = readSource(text);
  const at = new RegExp(`\\b${name}\\s*=\\s*\\[`).exec(reading.code);
  if (!at) return null;
  const open = at.index + at[0].length - 1;
  const close = closeOf(reading.code, open);
  if (close < 0) return null;
  return [...text.slice(open, close).matchAll(/["']([A-Za-z][\w-]*)["']/g)].map((m) => m[1]);
}

/** The entries of the literal at `brace`, refusing a spread: the tool reads a record by its own lines. */
function ownEntries(reading, text, brace, what, refusals) {
  const entries = entriesAt(reading, text, brace);
  if (!entries) {
    refusals.push(`old tests: ${what}: the record does not close; the tool cannot read what is mounted`);
    return [];
  }
  if (entries.some((entry) => entry.spread)) {
    refusals.push(`old tests: ${what}: a spread stands in the record; write one entry a line`);
    return [];
  }
  return entries;
}

const handed = (entries) =>
  entries.filter((entry) => entry.value === null || !NOTHING.test(entry.value)).map((entry) => entry.key);

/** The braces of the literals a file binds to `type`: `x: T = {`, and the `return {` of a function typed `): T {`. */
export function typedLiterals(reading, type) {
  const braces = [];
  for (const m of reading.code.matchAll(new RegExp(`:\\s*${type}\\s*=\\s*\\{`, "g")))
    braces.push(m.index + m[0].length - 1);
  for (const m of reading.code.matchAll(new RegExp(`\\)\\s*:\\s*${type}\\s*\\{`, "g"))) {
    const body = m.index + m[0].length - 1;
    const end = closeOf(reading.code, body);
    const inBody = reading.code.slice(body, end < 0 ? undefined : end);
    const ret = /\breturn\s*\(?\s*\{/.exec(inBody);
    if (ret) braces.push(body + ret.index + ret[0].length - 1);
  }
  return braces;
}

/**
 * The literals a call hands as its first argument: written there, or a name bound to one in the same file. A call
 * whose argument is neither is `unread`: the tool cannot say what it hands.
 */
function firstArgLiterals(reading, callee) {
  const braces = [];
  let unread = 0;
  for (const m of reading.code.matchAll(new RegExp(`\\b${callee}\\s*\\(\\s*`, "g"))) {
    const at = m.index + m[0].length;
    if (reading.code[at] === "{") {
      braces.push(at);
      continue;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(reading.code.slice(at))?.[0];
    const bound = name && new RegExp(`\\b${name}\\b[^=;{}()]*=\\s*\\{`).exec(reading.code);
    if (bound) braces.push(bound.index + bound[0].length - 1);
    else unread += 1;
  }
  return { braces, unread };
}

/** Whether the `{` at `brace` opens an object literal (a value), not a block or a type's body. */
function opensValue(code, brace) {
  let k = brace - 1;
  while (k >= 0 && /\s/.test(code[k])) k -= 1;
  if (code[k] === ">" && code[k - 1] === "=") return false;
  if ("(=,[?".includes(code[k] ?? "")) return true;
  return /\breturn$/.test(code.slice(Math.max(0, k - 6), k + 1));
}

/** The object literals of a file that hold any of `keys` as an entry of their own. */
function literalsHolding(reading, text, keys) {
  const found = [];
  for (let brace = reading.code.indexOf("{"); brace >= 0; brace = reading.code.indexOf("{", brace + 1)) {
    if (!opensValue(reading.code, brace)) continue;
    const entries = entriesAt(reading, text, brace);
    if (entries?.some((entry) => keys.includes(entry.key))) found.push(entries);
  }
  return found;
}

/**
 * @param {object} given
 * @param {string[]} given.files every file of the tree
 * @param {(rel: string) => string | null} given.textOf
 * @returns {{ targets: Set<string>, mounted: Set<string>, said: string[], refusals: string[] }}
 */
export function readMounted({ files, textOf }) {
  const said = [];
  const refusals = [];
  const mounted = new Set();
  const frame = textOf(FRAME_CONTRACT) ?? "";
  const placeIds = idsIn(frame, "PLACE_IDS") ?? [];
  const stageIds = idsIn(frame, "STAGE_IDS") ?? [];
  const paneIds = idsIn(textOf(SETTINGS_CONTRACT) ?? "", "PANE_IDS") ?? [];
  const targets = new Set([
    ...placeIds,
    ...paneIds.map((id) => `pane:${id}`),
    ...stageIds.map((id) => `stage:${id}`),
    "reader",
    "ground",
    "calendar",
  ]);
  if (!placeIds.length) said.push(`old tests: ${FRAME_CONTRACT} names no PLACE_IDS: no place can be named`);
  const mail = files.filter((rel) => rel.startsWith(MAIL) && /\.tsx?$/.test(rel) && !rel.endsWith(".d.ts"));
  const places = textOf(PLACES_FILE);
  if (places === null) said.push(`old tests: no ${PLACES_FILE}: no place is seated`);
  else {
    const reading = readSource(places);
    const bound = /\bSEATED\b[^=;{}()]*=\s*\{/.exec(reading.code);
    if (!bound)
      refusals.push(
        `old tests: ${PLACES_FILE} holds no record SEATED; the tool cannot read the seated places`,
      );
    else {
      const brace = bound.index + bound[0].length - 1;
      for (const key of handed(ownEntries(reading, places, brace, PLACES_FILE, refusals))) mounted.add(key);
    }
  }
  const kinds = [
    { type: "FrameStages", prefix: "stage:", none: "no stage is handed" },
    { type: "SettingsPanes", prefix: "pane:", none: "no Settings pane is handed", call: "settingsPlace" },
  ];
  for (const kind of kinds) {
    let found = 0;
    for (const rel of mail) {
      const text = textOf(rel) ?? "";
      const reading = readSource(text);
      const handedTo = kind.call ? firstArgLiterals(reading, kind.call) : { braces: [], unread: 0 };
      if (handedTo.unread)
        refusals.push(
          `old tests: ${rel} calls ${kind.call} with a record the tool cannot read; bind it to a name with its own lines`,
        );
      const braces = [...typedLiterals(reading, kind.type), ...handedTo.braces];
      for (const brace of new Set(braces)) {
        found += 1;
        for (const key of handed(ownEntries(reading, text, brace, `${rel} (${kind.type})`, refusals)))
          mounted.add(`${kind.prefix}${key}`);
      }
    }
    if (!found) said.push(`old tests: the mail entry holds no ${kind.type} record: ${kind.none}`);
  }
  if ([...mounted].some((id) => id.startsWith("pane:"))) mounted.add("settings");
  const supplies = textOf(SUPPLIES_FILE);
  if (supplies === null)
    said.push(`old tests: no ${SUPPLIES_FILE}: the mail hands no reader, no ground, no calendar`);
  else {
    const keys = ["reader", "above", "calendar"];
    for (const entries of literalsHolding(readSource(supplies), supplies, keys)) {
      for (const entry of entries) {
        if (entry.spread || !keys.includes(entry.key)) continue;
        if (entry.value === null || !NOTHING.test(entry.value))
          mounted.add(entry.key === "above" ? "ground" : entry.key);
      }
    }
  }
  for (const id of [...mounted]) {
    if (!targets.has(id))
      refusals.push(`old tests: the mail entry mounts "${id}", which no list of ids names`);
  }
  return { targets, mounted, said, refusals };
}
