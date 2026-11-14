/**
 * The kit's references are whole: `states.json` is the one list of what is compared, and nothing in
 * these folders says where a picture came from.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as base from "../../src/base/index.js";
import * as calendar from "../../src/calendar/index.js";
import * as mail from "../../src/mail/index.js";
import {
  fileOf,
  looksOf,
  PRIVATE,
  referenceKey,
  stateHash,
  stateKey,
  type StateRow,
} from "../compare/reference.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRIES = { base, mail, calendar } as const;
type Entry = keyof typeof ENTRIES;

interface States {
  rows: StateRow[];
  /** A part that is exported and drawn inside another's states: its name, and the component that shows it. */
  with?: Record<string, string>;
}
interface Manifest {
  rows: { key: string; file: string; scene: { sha256: string }; stateHash: string }[];
}

const json = <T>(entry: Entry, name: string): T =>
  JSON.parse(readFileSync(join(HERE, entry, name), "utf8")) as T;
const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)],
  );
const LISTS = new Set(["states.json", "manifest.json", "declared.json"]);

/** What is wrong with an entry's references, one line each. */
function missing(entry: Entry, states: States, manifest: Manifest): string[] {
  const out: string[] = [];
  const rows = new Map(manifest.rows.map((r) => [r.key, r]));
  const wanted = new Set<string>();
  for (const state of states.rows) {
    for (const look of looksOf(state)) {
      const key = referenceKey(state, look);
      wanted.add(key);
      const row = rows.get(key);
      const file = join(HERE, entry, `${key}.json`);
      if (!row) out.push(`${key}: no picture`);
      else if (row.stateHash !== stateHash(state)) out.push(`${key}: its picture is older than its state`);
      else if (row.file !== fileOf(key)) out.push(`${key}: its picture is filed under another name`);
      else if (!existsSync(file)) out.push(`${key}: no data file`);
      else if (sha256(readFileSync(file)) !== row.scene.sha256)
        out.push(`${key}: the data file is not the one its picture was taken with`);
    }
  }
  for (const key of rows.keys()) if (!wanted.has(key)) out.push(`${key}: a picture of no listed state`);
  for (const file of walk(join(HERE, entry))) {
    const name = relative(join(HERE, entry), file);
    if (!LISTS.has(name) && !wanted.has(name.replace(/\.json$/, "")))
      out.push(`${name}: a file of no listed state`);
  }
  return out;
}

describe.each(Object.keys(ENTRIES) as Entry[])("the references of %s", (entry) => {
  const states = json<States>(entry, "states.json");
  const manifest = json<Manifest>(entry, "manifest.json");

  it("every state has its picture and its data file, none older than its state", () => {
    expect(missing(entry, states, manifest)).toEqual([]);
  });

  it("a state without a picture, and a picture that outlived its state, are found", () => {
    const added: States = { rows: [...states.rows, { component: "Planted", state: "rest" }] };
    expect(missing(entry, added, manifest)).toContain("Planted/rest@paper-light-desktop: no picture");
    const first = states.rows[0];
    if (!first) return;
    const moved: States = { rows: [{ ...first, looks: ["paper-dark-phone"] }, ...states.rows.slice(1)] };
    expect(missing(entry, moved, manifest).join("\n")).toMatch(/older than its state|no picture/);
  });

  it("what the entry exports is what is compared", () => {
    const parts = Object.entries(ENTRIES[entry])
      .filter(([name, value]) => /^[A-Z][a-z]/.test(name) && typeof value === "function")
      .map(([name]) => name);
    const compared = new Set(states.rows.map((r) => r.component));
    const shown = states.with ?? {};
    expect(
      parts.filter((name) => !compared.has(name) && !shown[name]),
      "exported and never compared",
    ).toEqual([]);
    expect(
      Object.entries(shown)
        .filter(([name, inside]) => !parts.includes(name) || !compared.has(inside))
        .map(([name]) => name),
      "listed as shown inside another, and not so",
    ).toEqual([]);
    expect(
      [...compared].filter((name) => !parts.includes(name)),
      "compared and not exported",
    ).toEqual([]);
    expect(new Set(states.rows.map(stateKey)).size, "a state is listed twice").toBe(states.rows.length);
  });

  it("no reference file names a private path, a host or an address outside the invented world", () => {
    const files = walk(join(HERE, entry));
    expect(
      files.filter((file) => PRIVATE.test(readFileSync(file, "utf8"))).map((file) => relative(HERE, file)),
    ).toEqual([]);
  });
});

describe("what a reference file may not carry", () => {
  it.each([
    "site/simulator/index.html?screen=ohbox",
    "the sheet at system/index",
    "redesign-2026",
    "http://127.0.0.1:8796/x",
    "a-host.internal:8443",
    /* Put together here: a real provider's address is never written into the tree. */
    ["someone", "mailbox.org"].join("@"),
  ])("%s is refused", (text) => expect(PRIVATE.test(text)).toBe(true));

  it.each([
    "giulia@lichtgrat.example",
    "rgb(18, 16, 14)",
    "Wed 11 Nov, 08:00",
    "1.6",
    '"Hanken Grotesk", Arial',
  ])("%s is let through", (text) => expect(PRIVATE.test(text)).toBe(false));
});
