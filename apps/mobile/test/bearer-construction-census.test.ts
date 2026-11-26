/**
 * ONE PLACE BUILDS A BEARER MANAGER: `net/bearer-registry.ts`. A second manager over one pairing
 * slot presents a refresh token its twin already spent, and the server answers that by ending the
 * pairing. Read as CODE (comments and strings blanked), never as text: a value import of the class
 * is refused too, because an alias constructs without the spelling. Two doors beside it: the
 * paired session enters a slot only from `pairApproved`, and the store's three credential writes are
 * called only by `vaultFor`, the vault every manager's writes go through.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOTS = ["src", "app"];
/** The one file allowed to construct, and to import the class as a value. */
const ADMITTED = new Set(["src/net/bearer-registry.ts"]);
/** Where the class is defined: it names itself, and constructs nothing. */
const DEFINES = "src/net/bearer.ts";

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out.push(relative(APP, full));
    }
  };
  for (const root of ROOTS) walk(join(APP, root));
  return out.sort();
}

/** Every `new BearerManagerRN(` in CODE, as `file:line`. */
function constructions(rel: string, text: string): string[] {
  const code = withoutCommentsAndLiterals(text);
  return [...code.matchAll(/\bnew\s+BearerManagerRN\s*[(<]/g)].map((m) => `${rel}:${lineOf(code, m.index ?? 0)}`);
}

/** Every import that brings the class in as a VALUE (not `import type`, not `type X`). */
function valueImports(rel: string, text: string): string[] {
  const code = withoutComments(text);
  const found: string[] = [];
  for (const m of code.matchAll(/\bimport\s+(type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*["']/g)) {
    if (m[1]) continue;
    const names = (m[2] ?? "").split(",").map((s) => s.trim());
    if (names.some((n) => /^BearerManagerRN(\s+as\s+\w+)?$/.test(n))) found.push(`${rel}:${lineOf(code, m.index ?? 0)}`);
  }
  return found;
}

function census(files: Array<[string, string]>): { built: string[]; imported: string[]; inRegistry: number } {
  const built: string[] = [];
  const imported: string[] = [];
  let inRegistry = 0;
  for (const [rel, text] of files) {
    const here = constructions(rel, text);
    if (ADMITTED.has(rel)) inRegistry += here.length;
    else built.push(...here);
    if (!ADMITTED.has(rel) && rel !== DEFINES) imported.push(...valueImports(rel, text));
  }
  return { built, imported, inRegistry };
}

const tree = (): Array<[string, string]> => sources().map((rel) => [rel, readFileSync(join(APP, rel), "utf8")]);

/** The body of `function <name>(` in `rel`, as a [start, end) span of the blanked code. */
function bodyOf(code: string, name: string): [number, number] | null {
  const at = code.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  const params = bracketSpan(code, code.indexOf("(", at));
  const open = code.indexOf("{", params.end);
  const body = bracketSpan(code, open, "{", "}");
  return body.closed ? [body.start, body.end] : null;
}

/**
 * Every member CALL of one of `verbs`, as `file:line`, except those inside `function <home>(` in
 * `homeFile`. A definition (`verb(…) {` in a class) is not a member call and is not counted.
 */
function callsOutside(files: Array<[string, string]>, verbs: string[], homeFile: string, home: string) {
  const outside: string[] = [];
  let inside = 0;
  const pattern = new RegExp(`\\.(${verbs.join("|")})\\s*\\(`, "g");
  for (const [rel, text] of files) {
    const code = withoutCommentsAndLiterals(text);
    const span = rel === homeFile ? bodyOf(code, home) : null;
    for (const m of code.matchAll(pattern)) {
      const at = m.index ?? 0;
      if (span !== null && at >= span[0] && at < span[1]) inside += 1;
      else outside.push(`${rel}:${lineOf(code, at)}`);
    }
  }
  return { outside, inside };
}

const STORE_WRITES = ["saveRefreshToken", "clearRefreshToken", "armRefreshAttempt"];

describe("the bearer manager is built in one place", () => {
  it("no file under src or app constructs one, or imports the class as a value, but the registry", () => {
    const files = tree();
    expect(files.length, "the walk read the app").toBeGreaterThan(100);
    const got = census(files);
    expect(got.built, "a manager built outside the registry").toEqual([]);
    expect(got.imported, "the class imported as a value outside the registry").toEqual([]);
    expect(got.inRegistry, "the registry constructs from a row and from a redeem, so the reading is not vacuous").toBe(2);
  });

  it("a paired session enters a slot only from pairApproved; the store's credential writes only from vaultFor", () => {
    const files = tree();
    const redeem = callsOutside(files, ["adoptRedeem"], "src/net/pairing.ts", "pairApproved");
    expect(redeem.outside, "adoptRedeem called outside pairApproved").toEqual([]);
    expect(redeem.inside, "pairApproved adopts the session").toBe(1);
    const writes = callsOutside(files, STORE_WRITES, "src/net/pairing.ts", "vaultFor");
    expect(writes.outside, "a credential write outside vaultFor").toEqual([]);
    expect(writes.inside, "vaultFor binds all three").toBe(3);
  });

  it("CONTROL: the two doors refuse a planted call, and admit their own", () => {
    const rel = "src/net/connection.tsx";
    const real = readFileSync(join(APP, rel), "utf8");
    const plant = (line: string): Array<[string, string]> => [[rel, `${real}\n${line}\n`]];
    expect(callsOutside(plant("void bearers.adoptRedeem(id, redeem);"), ["adoptRedeem"], "src/net/pairing.ts", "pairApproved").outside)
      .toHaveLength(1);
    expect(callsOutside(plant("void env.profiles.clearRefreshToken(id, t);"), STORE_WRITES, "src/net/pairing.ts", "vaultFor").outside)
      .toHaveLength(1);
    const pairing = "src/net/pairing.ts";
    const own = readFileSync(join(APP, pairing), "utf8");
    expect(callsOutside([[pairing, own]], STORE_WRITES, pairing, "vaultFor").outside, "vaultFor's own calls are admitted").toEqual([]);
  });

  it("CONTROL: a call planted in a copy of the connection layer is found; a comment or a string is not", () => {
    const rel = "src/net/connection.tsx";
    const real = readFileSync(join(APP, rel), "utf8");
    const planted = `${real}\nconst twin = new BearerManagerRN({ origin: "x", refreshToken: null, vault: v });\n`;
    const quoted = `${real}\n// new BearerManagerRN({ origin })\nconst s = "new BearerManagerRN(";\n`;
    const plantedAt = `${rel}:${planted.split("\n").length - 1}`;
    expect(census([[rel, planted]]).built).toEqual([plantedAt]);
    expect(census([[rel, quoted]]).built).toEqual([]);
    const aliased = `import { BearerManagerRN as M } from "./bearer";\n${real}`;
    expect(census([[rel, aliased]]).imported).toEqual([`${rel}:1`]);
    expect(census([[rel, `import type { BearerManagerRN } from "./bearer";\n${real}`]]).imported).toEqual([]);
  });
});
