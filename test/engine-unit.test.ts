import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ENGINE_DOOR, engineUnitFiles, readEngineAsOneText } from "./support/engine-unit.js";

/**
 * THE ENGINE'S ONE TEXT PLACES EVERY UNIT ONCE, OR REFUSES. The tests that read the desktop's engine as text
 * read it through `readEngineAsOneText`. Once the engine stands in `engine-*.ts` files beside its door, a unit
 * the door spells in a shape the helper does not place would leave their text short, and a reader that looks
 * for an absence would read green over it. The fixture is the cut's own form, as the split's rehearsal
 * writes it: a door, one prelude it re-exports, one section it calls, and the two records.
 */

const DOOR = `import { createApp } from "@trafficflow/api/local";
import {
  withPullKick,
} from "./engine-routes.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";
import { drainSection } from "./engine-mailbox-drain.js";

export {
  LOCAL_JOIN_HEAL_EVERY_MS, withPullKick,
} from "./engine-routes.js";

export async function createSidecar(config: SidecarConfig): Promise<Sidecar> {
  const scope = {} as EngineScope;
  const log = config.log;
    Object.assign(scope, {
      log,
    } satisfies Partial<EngineScope>);
    const attachLocal = (mb: LocalRosterRow): void => {
      const box = {} as MailboxScope;
      drainSection(scope, box, config, mb);
      void box.drain();
    };
    scope.attachLocal = attachLocal;
  return createApp(withPullKick(scope.log));
}
`;

const PRELUDE = `// The desktop's engine: the passes' constants, the drain's summary and the four route wrappers.

import { errorResponse, type Route } from "@trafficflow/api/local";

/** How often a launch runs the thread-join heal at the tail of a drain. */
export const LOCAL_JOIN_HEAL_EVERY_MS = 6 * 60 * 60 * 1000;

export function withPullKick(route: Route): Route {
  return route ?? errorResponse(503);
}
`;

const SECTION = `import type { LocalRosterRow } from "./identity.js";
import { stampSynced } from "./sync-stamp.js";
import type { SidecarConfig } from "./engine-types.js";
import { LOCAL_JOIN_HEAL_EVERY_MS } from "./engine-routes.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/** The desktop's engine, one section: one mailbox's drain. */
export function drainSection(scope: EngineScope, box: MailboxScope, config: SidecarConfig, mb: LocalRosterRow): void {
      const drain = async (): Promise<void> => {
        scope.log("sync_drain", { mailbox: mb.id, every: LOCAL_JOIN_HEAL_EVERY_MS });
        await stampSynced(config, mb);
      };
      box.drain = drain;
}
`;

const ENGINE_SCOPE = `import type { Diagnostic } from "./log.js";

/** What the engine's sections share, per install. */
export interface EngineScope {
  log: Diagnostic;
  attachLocal: (mb: LocalRosterRow) => void;
}
`;

const MAILBOX_SCOPE = `/** What one mailbox's sections share. */
export interface MailboxScope {
  drain: () => Promise<void>;
}
`;

/** One line each unit holds and no other, as the one text spells it. */
const OWN_LINES = {
  door: "  return createApp(withPullKick(log));",
  prelude: "export const LOCAL_JOIN_HEAL_EVERY_MS = 6 * 60 * 60 * 1000;",
  section: '        log("sync_drain", { mailbox: mb.id, every: LOCAL_JOIN_HEAL_EVERY_MS });',
};

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** The fixture in a folder of its own, named through `join` as the platform writes a path. */
function unit(edit: { door?: (door: string) => string; section?: (section: string) => string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-unit-"));
  made.push(dir);
  const door = edit.door?.(DOOR) ?? DOOR;
  const section = edit.section?.(SECTION) ?? SECTION;
  if (door === DOOR && section === SECTION && Object.keys(edit).length > 0) throw new Error("the edit changed nothing");
  const files: Record<string, string> = {
    "engine.ts": door,
    "engine-routes.ts": PRELUDE,
    "engine-mailbox-drain.ts": section,
    "engine-scope.ts": ENGINE_SCOPE,
    "engine-mailbox-scope.ts": MAILBOX_SCOPE,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const times = (text: string, line: string): number => text.split("\n").filter((l) => l === line).length;
const CALL = "      drainSection(scope, box, config, mb);";

const RECORDS = new Set(["engine-scope", "engine-mailbox-scope"]);

/**
 * The lines of a unit file the one text carries: a section's body; a prelude's lines after its last import; the
 * door's lines but its import and re-export statements.
 */
function carried(text: string, isDoor: boolean): string[] {
  const lines = text.split("\n");
  const sig = lines.findIndex((l) => /^export (?:async )?function \w+Section\(/.test(l));
  if (sig >= 0) {
    let open = sig;
    while (open < lines.length && !/\{\s*$/.test(lines[open]!)) open += 1;
    return lines.slice(open + 1, lines.findIndex((l, i) => i > open && /^\}\s*$/.test(l)));
  }
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^(?:import\b|export (?:type )?\{)/.test(lines[i]!)) {
      while (i < lines.length && !/;\s*$/.test(lines[i]!)) i += 1;
      if (!isDoor) out.length = 0;
      continue;
    }
    out.push(lines[i]!);
  }
  return out;
}

/**
 * A line of one unit file that no other unit file holds and that the one text carries as written: no record
 * spelling, no name of a record's field, no shorthand, no maker call, not the prelude's first line.
 */
function ownLine(text: string, isDoor: boolean, everyLine: string[], fields: ReadonlySet<string>): string | undefined {
  return carried(text, isDoor).find((line) =>
    line.trim().length >= 24 &&
    !line.startsWith("// The desktop's engine:") &&
    !/Section\(/.test(line) &&
    !/\b([A-Za-z_$][\w$]*): \1\b/.test(line) &&
    !(line.match(/[A-Za-z_$][\w$]*/g) ?? []).some((word) => word === "scope" || word === "box" || fields.has(word)) &&
    everyLine.filter((l) => l === line).length === 1);
}

/** A door the helper cannot place every unit of: its shape, the unit it must name, the edit. */
const DOOR_PLANTS: [string, string, (door: string) => string][] = [
  ["the prelude's re-export removed, its import kept", "engine-routes", (d) => d.replace(/\nexport \{\n[^}]*\} from "\.\/engine-routes\.js";\n/, "\n")],
  ["the section's call behind void", "drainSection", (d) => d.replace(CALL, "      void drainSection(scope, box, config, mb);")],
  ["the section's call over two lines", "drainSection", (d) => d.replace(CALL, "      drainSection(\n        scope, box, config, mb,\n      );")],
  ["the section's call written twice", "drainSection", (d) => d.replace(CALL, `${CALL}\n${CALL}`)],
];

/** A section file with a statement the one text would drop or misplace: where, the edit. */
const SECTION_PLANTS: [string, (section: string) => string][] = [
  ["before its maker", (s) => s.replace("\n/** The desktop's engine", '\nconst DRAIN_LABEL = "drain";\n\n/** The desktop\'s engine')],
  ["after its maker", (s) => `${s}\nfunction drainLabel(): string {\n  return "drain";\n}\n`],
];

describe("the engine read as one text", () => {
  // The engine stands cut: its door with the prelude, the records and the sections beside it.
  it("reads the cut engine without a throw, every unit file once", () => {
    const files = engineUnitFiles();
    expect(files[0]).toBe(ENGINE_DOOR);
    expect(files.length, "the engine stands in one file").toBeGreaterThan(1);
    const one = readEngineAsOneText();
    const units = new Map(files.map((f) => [basename(f, ".ts"), readFileSync(f, "utf8")]));
    const fields = new Set(
      [...RECORDS].flatMap((name) => [...(units.get(name) ?? "").matchAll(/^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]!)),
    );
    expect(fields.size, "the records name no field").toBeGreaterThan(0);
    expect(one).not.toMatch(/from "\.\/engine-[\w-]+\.js"/);
    expect(one).not.toMatch(/\w+Section\(/);
    expect(one).not.toMatch(/interface (?:EngineScope|MailboxScope)\b/);
    const everyLine = [...units.values()].flatMap((text) => text.split("\n"));
    for (const [name, text] of units) {
      if (RECORDS.has(name)) continue;
      const line = ownLine(text, name === "engine", everyLine, fields);
      expect(line, `${name} carries no line of its own`).toBeDefined();
      expect(times(one, line!), `${name}: ${line}`).toBe(1);
    }
  });

  // A section's body ends with its hand-over lines, `box.x = x;`; a statement before them is kept.
  it("carries every line of every section's body, as often as the sections hold it", () => {
    const units = new Map(engineUnitFiles().map((f) => [basename(f, ".ts"), readFileSync(f, "utf8")]));
    const fields = new Set(
      [...RECORDS].flatMap((name) => [...(units.get(name) ?? "").matchAll(/^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]!)),
    );
    const unspelled = (line: string): string => line
      .replace(/\b(?:scope|box)\.([A-Za-z_$][\w$]*)/g, (whole, name: string) => (fields.has(name) ? name : whole))
      .replace(/\b([A-Za-z_$][\w$]*): \1(?=,|\s*\}|\s*$)/g, "$1");
    const count = (lines: string[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const body: string[] = [];
    for (const [name, text] of units) {
      if (RECORDS.has(name) || !/^export (?:async )?function \w+Section\(/m.test(text)) continue;
      const lines = carried(text, false);
      while (lines.length > 0 && (/^\s*(?:scope|box)\.([\w$]+) = \1;\s*$/.test(lines.at(-1)!) || lines.at(-1)!.trim() === "")) lines.pop();
      body.push(...lines.filter((l) => l.trim() !== "").map(unspelled));
    }
    expect(body.length, "no section was read").toBeGreaterThan(0);
    const one = count(readEngineAsOneText().split("\n"));
    const short = [...count(body)].filter(([line, n]) => (one.get(line) ?? 0) < n)
      .map(([line, n]) => `${line.trim()}: ${one.get(line) ?? 0} of ${n}`);
    expect(short).toEqual([]);
  });

  it("gives the door, its prelude and its section each once, the records' spelling taken out", () => {
    const one = readEngineAsOneText(unit());
    for (const line of Object.values(OWN_LINES)) expect(times(one, line), line).toBe(1);
    expect(one).not.toContain("drainSection(");
    expect(one).not.toContain('} from "./engine-routes.js";');
    expect(one).not.toMatch(/\b(?:scope|box)\.(?:log|drain)\b/);
  });

  // On Windows `join` writes `\`: a unit keyed by a slice of its path would never be placed there.
  it("keys each unit by its file's name, however its folder is spelled", () => {
    const dir = unit();
    const asJoined = readEngineAsOneText(dir);
    expect(times(asJoined, OWN_LINES.prelude)).toBe(1);
    expect(readEngineAsOneText(`${dir}${sep}.`)).toBe(asJoined);
  });

  it.each(DOOR_PLANTS)("refuses a door with %s, naming the unit", (_shape, unitName, door) => {
    const dir = unit({ door });
    expect(() => readEngineAsOneText(dir)).toThrow(new RegExp(`left out or doubled: .*\\b${unitName}\\b`));
  });

  it.each(SECTION_PLANTS)("refuses a section file that holds a statement %s", (_where, section) => {
    const dir = unit({ section });
    expect(() => readEngineAsOneText(dir)).toThrow(/engine-mailbox-drain .*statement outside its imports and its maker/);
  });

  // A file named off the unit's pattern is never read: the door's statement naming it would drop it unseen.
  it("refuses a door that names an engine file the unit does not hold", () => {
    const dir = unit({
      door: (d) => d.replace('} from "./engine-routes.js";\n\nexport async', '} from "./engine-routes.js";\nexport { summarizeDrain } from "./engine-Routes.js";\n\nexport async'),
    });
    expect(() => readEngineAsOneText(dir)).toThrow("the engine's one text cannot place ./engine-Routes.js: no unit file of that name");
  });
});
