// What a host's entry mounts on the new shell, read from the tree as text: the places seated in the mail's one
// record, the stages and the Settings panes the mail hands, and what its supplies hand the frame beside them (the
// reader, the ground above the places, the calendar). Nothing is run. Where a file of the mail entry is not in
// the tree, nothing of its kind is mounted, and that is said in one line.
import { closeOf, entriesAt, readSource, topLevelParts } from "./source-text.mjs";

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

const NAME = "[A-Za-z_$][\\w$]*";
const simpleName = new RegExp(`^${NAME}$`);
const conditionalNames = new RegExp(`^[^;{}?]+\\?\\s*(${NAME})\\s*:\\s*(${NAME})$`);
const localCall = new RegExp(`^(${NAME})\\s*\\(`);

/** Stop at a statement or scope boundary, keeping balanced calls and literals whole. */
function expressionEnd(code, from, limit = code.length) {
  for (let at = from; at < limit; at += 1) {
    const char = code[at];
    if (char === ";" || char === "}") return at;
    if ("([{".includes(char)) {
      at = closeOf(code, at);
      if (at < 0 || at >= limit) return null;
    }
  }
  return limit;
}

/** Read a function only when its entire body is a single return statement. */
function returnedBy(code, name) {
  const fn = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(code);
  if (!fn) return null;
  const params = closeOf(code, fn.index + fn[0].length - 1);
  if (params < 0) return null;
  const head = /^\s*(?::[^{;]*)?\{/.exec(code.slice(params + 1));
  if (!head) return null;
  const body = params + 1 + head[0].length - 1;
  const end = closeOf(code, body);
  if (end < 0) return null;
  const ret = /^\s*return(?![\w$])[ \t]*/.exec(code.slice(body + 1, end));
  if (!ret) return null;
  const at = body + 1 + ret[0].length;
  if (/[\r\n\u2028\u2029]/.test(code[at] ?? "")) return null;
  const until = expressionEnd(code, at, end);
  if (until === null || (until < end && (code[until] !== ";" || code.slice(until + 1, end).trim())))
    return null;
  return [at, until];
}

/** The records an argument may supply: a literal, a local name, or a choice between local names. */
function settingsRecords(reading, at, end, seen = new Set()) {
  const { code } = reading;
  at += /^\s*/.exec(code.slice(at, end))[0].length;
  const expression = code.slice(at, end).trimEnd();
  end = at + expression.length;
  if (expression.startsWith("(") && closeOf(code, at) === end - 1)
    return settingsRecords(reading, at + 1, end - 1, seen);

  if (expression.startsWith("{")) {
    const close = closeOf(code, at);
    if (close < 0 || close >= end || !/^\s*(?:as\s+const)?$/.test(code.slice(close + 1, end))) return null;
    const entries = entriesAt(reading, reading.bare, at);
    if (entries === null) return null;
    const merged = new Map();
    for (const entry of entries) {
      if (!entry.spread) {
        merged.set(entry.key, entry);
        continue;
      }
      const name = entry.spread.slice(3).trim();
      if (!simpleName.test(name)) return null;
      const source = boundRecords(reading, name, seen);
      if (source?.length !== 1) return null;
      for (const field of source[0]) merged.set(field.key, field);
    }
    return [[...merged.values()]];
  }
  const choice = conditionalNames.exec(expression);
  if (choice) {
    const first = boundRecords(reading, choice[1], seen);
    const second = boundRecords(reading, choice[2], seen);
    return first && second ? [...first, ...second] : null;
  }
  if (simpleName.test(expression)) return boundRecords(reading, expression, seen);
  const call = localCall.exec(expression);
  if (call && closeOf(code, at + call[0].length - 1) === end - 1) return boundRecords(reading, call[1], seen);
  return null;
}

function boundRecords(reading, name, seen) {
  if (seen.has(name)) return null;
  const visited = new Set([...seen, name]);
  const binding = name.replaceAll("$", "\\$");
  const { code } = reading;
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${binding}\\b[^=;{}()]*=\\s*`).exec(code);
  if (declaration) {
    const at = declaration.index + declaration[0].length;
    const end = expressionEnd(code, at);
    return end === null ? null : settingsRecords(reading, at, end, visited);
  }
  const returned = returnedBy(code, binding);
  return returned === null ? null : settingsRecords(reading, returned[0], returned[1], visited);
}

/** The records passed to a registration, with unread arguments counted separately. */
function firstArgRecords(reading, callee) {
  const records = [];
  let unread = 0;
  const { code } = reading;
  for (const m of code.matchAll(new RegExp(`\\b${callee}\\s*\\(`, "g"))) {
    const open = m.index + m[0].length - 1;
    const end = closeOf(code, open);
    const arg = end < 0 ? undefined : topLevelParts(code, open + 1, end)[0];
    const resolved = arg ? settingsRecords(reading, arg[0], arg[1]) : null;
    if (resolved === null) unread += 1;
    else records.push(...resolved);
  }
  return { records, unread };
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

/** The signed-in browser can add Calendar to the shared frame once it has the account's calendar port. */
function browserHandsCalendar(source) {
  const reading = readSource(source);
  const imported = /\bimport\s*\{([^}]*)\}\s*from\s*["']@ohmail\/app\/calendar["']/.exec(reading.bare);
  const binding = imported?.[1]
    .split(",")
    .map((part) => /^calendar(?:\s+as\s+(\w+))?$/.exec(part.trim()))
    .find(Boolean);
  if (!binding) return false;
  const name = binding[1] ?? "calendar";
  for (const entries of literalsHolding(reading, source, ["frame"])) {
    const frame = entries.find((entry) => entry.key === "frame")?.value;
    if (!frame) continue;
    const result = readSource(frame);
    for (const object of result.code.matchAll(/(?:^|[?:])\s*\{/g)) {
      const fields = entriesAt(result, frame, object.index + object[0].length - 1);
      const last = fields?.findLast((field) => field.key === "calendar" || field.spread);
      if (last?.key === "calendar" && (last.value ?? last.key) === name) return true;
    }
  }
  return false;
}

/** The signed-in host selects its shared Reader, which may register an invitation renderer. */
function readerInvitation(files, textOf) {
  const screen = "apps/webapp/app/(product)/mailbox/CloudShell.tsx";
  if (!files.includes(screen)) return false;
  const page = readSource(textOf(screen) ?? "");
  const web = readSource(textOf("apps/webapp/app/(product)/mailbox/mail-parts.tsx") ?? "");
  const browser = readSource(textOf("apps/webapp/app/shell/browser-mail.tsx") ?? "");
  const parts = readSource(textOf("packages/app/src/mail/reader-parts.ts") ?? "");
  if (
    !/^\s*import\s*\{[^}]*\bWEB_MAIL_PARTS\b[^}]*\}\s*from\s*["']\.\/mail-parts["']/m.test(page.bare) ||
    !/\buseBrowserMail\s*\(\s*\w+\s*,\s*WEB_MAIL_PARTS\s*\)/.test(page.code) ||
    !/^\s*import\s*\{[^}]*\bBROWSER_READER\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/shell\/browser-mail["']/m.test(
      web.bare,
    )
  )
    return null;

  function record(source, opening) {
    const hits = [...source.code.matchAll(opening)];
    if (hits.length !== 1) return null;
    const fields = entriesAt(source, source.bare, hits[0].index + hits[0][0].length - 1);
    return fields && !fields.some((field) => field.spread) ? fields : null;
  }
  function value(fields, key) {
    const named = fields?.filter((field) => field.key === key);
    return named?.length === 1 ? (named[0].value ?? named[0].key) : null;
  }
  const host = record(web, /\bWEB_MAIL_PARTS\s*:\s*MailHostParts\s*=\s*\{/g);
  if (value(host, "reader") !== "BROWSER_READER") return null;
  const entry = record(browser, /\bBROWSER_READER\s*=\s*mailReader\s*\(\s*\{/g);
  const returned = record(parts, /\breturn\s+useMemo\s*\(\s*\(\s*\)\s*=>\s*\(\s*\{/g);
  if (!entry || !returned) return null;
  const slot = value(returned, "invitation");
  if (slot === '"none"' || slot === "'none'" || slot === "NONE") return false;
  if (
    slot !== "invitation" ||
    !/\bconst\s+invitation\s*=\s*host\.invitation\s*\?\?\s*["']none["']/.test(parts.bare)
  )
    return null;
  const supplied = entry.filter((field) => field.key === "invitation");
  if (!supplied.length) return false;
  if (supplied.length !== 1) return null;
  const renderer = value(entry, "invitation");
  if (renderer === "NONE" || renderer === '"none"' || renderer === "'none'") return false;
  if (
    renderer === "ReaderInvitation" &&
    /^\s*import\s*\{\s*ReaderInvitation\s*\}\s*from\s*["']\.\.\/components\/ReaderInvitation["']/m.test(
      browser.bare,
    ) &&
    files.includes("apps/webapp/app/components/ReaderInvitation.tsx")
  )
    return true;
  return null;
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
    "reader:invitation",
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
      const handedTo = kind.call ? firstArgRecords(reading, kind.call) : { records: [], unread: 0 };
      if (handedTo.unread)
        refusals.push(
          `old tests: ${rel} calls ${kind.call} with a record the tool cannot read; bind it to a name with its own lines`,
        );
      const records = typedLiterals(reading, kind.type).map((brace) =>
        ownEntries(reading, text, brace, `${rel} (${kind.type})`, refusals),
      );
      for (const record of [...records, ...handedTo.records]) {
        found += 1;
        for (const key of handed(record)) mounted.add(`${kind.prefix}${key}`);
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
  const web = "apps/webapp/app/(product)/mailbox/web-supplies.tsx";
  if (files.includes(web) && browserHandsCalendar(textOf(web) ?? "")) mounted.add("calendar");
  const invitation = readerInvitation(files, textOf);
  if (invitation === true) mounted.add("reader:invitation");
  if (invitation === null)
    refusals.push("old tests: the signed-in Reader's invitation registration cannot be determined");
  for (const id of [...mounted]) {
    if (!targets.has(id))
      refusals.push(`old tests: the mail entry mounts "${id}", which no list of ids names`);
  }
  return { targets, mounted, said, refusals };
}
