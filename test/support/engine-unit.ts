import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * THE DESKTOP'S ENGINE AS THE TESTS THAT READ IT AS TEXT SEE IT. `engine.ts` is the door; the cut moves its
 * prelude and its sections into flat `engine-*.ts` files beside it. A test that reads or lists the engine takes
 * it from here, so one that named `engine.ts` alone never goes blind over the moved code. Here and not in the
 * sidecar's test folder because tests of other apps and packages read the engine too, and an app's test folder
 * is no import of theirs; every reader, the sidecar's own too, imports this file by its relative path.
 */

/**
 * The door, `apps/sidecar/src/engine.ts`. Found by walking up from the working folder, as `wordmark.ts`
 * does: under a jsdom environment `import.meta.url` is no `file:` URL. Named as the door in one literal,
 * never as its folder or a bare `apps`, so the test selection reads a reader of the engine as it read one
 * before the cut, and not as a census of the whole tree.
 */
export const ENGINE_DOOR = ((): string => {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "tools/tsconfig.base.json"))) return join(dir, "apps/sidecar/src/engine.ts");
    if (dirname(dir) === dir) throw new Error(`no repository root above ${process.cwd()}`);
  }
})();

/** The engine's source folder, `apps/sidecar/src`. */
export const ENGINE_SRC = dirname(ENGINE_DOOR);

const UNIT_FILE = /^engine(-[a-z0-9]+(?:-[a-z0-9]+)*)?\.ts$/;

/** Every file of the engine: the door first, then each `engine-*.ts` by name, read from the folder. */
export function engineUnitFiles(dir: string = ENGINE_SRC): string[] {
  const names = readdirSync(dir).filter((n) => UNIT_FILE.test(n));
  if (!names.includes("engine.ts")) throw new Error(`no engine.ts in ${dir}`);
  return ["engine.ts", ...names.filter((n) => n !== "engine.ts").sort()].map((n) => join(dir, n));
}

/**
 * A file the cut moved out of the door (`engine-*.ts`): a walk that names the door reads it inside the door, so
 * each walk leaves it out of its list. `readingTheUnit` does not read it as "": a test naming a part would then
 * pass over nothing, where a walk that forgets this filter reads a section twice and goes blind over none.
 */
export function isEnginePart(path: string): boolean {
  const name = basename(path);
  return name !== "engine.ts" && UNIT_FILE.test(name) && resolve(dirname(path)) === resolve(ENGINE_SRC);
}

/** A walk's reader: the door as the engine's one text, every other file by `read`. */
export function readingTheUnit(read: (path: string) => string): (path: string) => string {
  return (path) => (resolve(path) === resolve(ENGINE_DOOR) ? readEngineAsOneText() : read(path));
}

/** A source file as such a walk reads it: the door as the engine's one text, any other file as it stands. */
export function readAsUnit(path: string): string {
  return readingTheUnit((p) => readFileSync(p, "utf8"))(path);
}

/** A top-level statement's lines from `at`: up to the line that ends it with `;`. */
function statementEnd(lines: string[], at: number): number {
  let i = at;
  while (i < lines.length && !/;\s*$/.test(lines[i]!)) i += 1;
  return i;
}

/** Field names of an interface the cut writes (`interface EngineScope { … }`). */
function recordFields(text: string, name: string): string[] {
  const start = text.indexOf(`interface ${name} {`);
  if (start < 0) return [];
  const body = text.slice(start, text.indexOf("\n}", start));
  return [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\??:/gm)].map((m) => m[1]!);
}

/** A unit file's import statements and the lines after them. */
function splitImports(text: string): { imports: string[]; rest: string[] } {
  const lines = text.split("\n");
  const imports: string[] = [];
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^import\b/.test(lines[i]!)) continue;
    const end = statementEnd(lines, i);
    imports.push(lines.slice(i, end + 1).join("\n"));
    last = end;
    i = end;
  }
  let from = last + 1;
  while (from < lines.length && lines[from]!.trim() === "") from += 1;
  return { imports, rest: lines.slice(from) };
}

/** The lines that are no import, no comment and not blank: a statement the one text would not carry. */
function statementsAmong(lines: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      while (i < lines.length && !lines[i]!.includes("*/")) i += 1;
      continue;
    }
    if (/^import\b/.test(line)) {
      i = statementEnd(lines, i);
      continue;
    }
    found.push(line);
  }
  return found;
}

/**
 * A section file's body: inside its maker, the hand-over lines at its end taken off. The maker ends at its
 * first `}` at the start of a line; a statement before it or after it is refused, not dropped.
 */
function sectionBody(name: string, text: string): string[] {
  const lines = text.split("\n");
  const sig = lines.findIndex((l) => /^export (?:async )?function \w+Section\(/.test(l));
  let open = sig;
  while (open < lines.length && !/\{\s*$/.test(lines[open]!)) open += 1;
  const close = lines.findIndex((l, i) => i > open && /^\}\s*$/.test(l));
  if (close < 0) throw new Error(`the engine's section ${name} has no end to its maker`);
  const outside = [...statementsAmong(lines.slice(0, sig)), ...statementsAmong(lines.slice(close + 1))];
  if (outside.length > 0) {
    throw new Error(`the engine's section ${name} holds a statement outside its imports and its maker: ${outside[0]}`);
  }
  const body = lines.slice(open + 1, close);
  while (body.length > 0 && (/^\s*(?:scope|box)\.([\w$]+) = \1;\s*$/.test(body.at(-1)!) || body.at(-1)!.trim() === "")) body.pop();
  return body;
}

/**
 * The engine as one text: the door with each prelude file's runs and each section's body put back where its
 * export statement or maker call stands, the unit's own import lines on top, the record spelling taken out
 * (`scope.x`, `box.x`), the section-end lines dropped. Before the cut it is `engine.ts` as it stands.
 */
export function readEngineAsOneText(dir: string = ENGINE_SRC): string {
  const files = engineUnitFiles(dir);
  const door = readFileSync(files[0]!, "utf8");
  if (files.length === 1) return door;
  const units = new Map(files.slice(1).map((f) => [basename(f, ".ts"), readFileSync(f, "utf8")]));
  const fields = new Set([
    ...recordFields(units.get("engine-scope") ?? "", "EngineScope"),
    ...recordFields(units.get("engine-mailbox-scope") ?? "", "MailboxScope"),
  ]);
  const sections = new Map<string, string[]>();
  const preludes = new Map<string, string[]>();
  const unitImports: string[] = [];
  for (const [name, text] of units) {
    if (name === "engine-scope" || name === "engine-mailbox-scope") continue;
    const maker = /^export (?:async )?function (\w+Section)\(/m.exec(text)?.[1];
    const { imports, rest } = splitImports(text);
    for (const s of imports) if (!/from "\.\/engine-[\w-]+\.js";/.test(s) && !unitImports.includes(s)) unitImports.push(s);
    if (maker !== undefined) sections.set(maker, sectionBody(name, text));
    else preludes.set(name, rest.filter((l) => !l.startsWith("// The desktop's engine:")));
  }
  const lines = door.split("\n");
  const out: string[] = [];
  const placed = new Set<string>();
  const used = new Map<string, number>();
  let lastImport = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const unitStatement = /^(?:import|export)\b/.test(line) ? statementEnd(lines, i) : -1;
    if (unitStatement >= 0) {
      const text = lines.slice(i, unitStatement + 1).join("\n");
      const from = /from "\.\/(engine-[\w-]+)\.js";/.exec(text)?.[1];
      if (from !== undefined) {
        if (!units.has(from)) throw new Error(`the engine's one text cannot place ./${from}.js: no unit file of that name`);
        if (preludes.has(from) && /^export\b/.test(line) && !placed.has(from)) {
          placed.add(from);
          out.push(...preludes.get(from)!);
        }
        i = unitStatement;
        continue;
      }
      if (/^import\b/.test(line)) {
        out.push(...lines.slice(i, unitStatement + 1));
        lastImport = out.length - 1;
        i = unitStatement;
        continue;
      }
    }
    if (/^\s*const (?:scope|box) = \{\} as (?:EngineScope|MailboxScope);\s*$/.test(line)) continue;
    if (/^\s*scope\.attachLocal = attachLocal;\s*$/.test(line)) continue;
    if (/^\s*Object\.assign\(scope, \{\s*$/.test(line)) {
      while (i < lines.length && !/satisfies Partial<EngineScope>\);\s*$/.test(lines[i]!)) i += 1;
      continue;
    }
    const call = /^\s*(?:await )?(\w+Section)\([\w, ]*\);\s*$/.exec(line)?.[1];
    if (call !== undefined && sections.has(call)) {
      used.set(call, (used.get(call) ?? 0) + 1);
      out.push(...sections.get(call)!);
      continue;
    }
    out.push(line);
  }
  // A unit spelled in any other shape (a trimmed re-export, a wrapped, `void` or doubled call) is refused here.
  const wrong = [
    ...[...preludes.keys()].filter((name) => !placed.has(name)),
    ...[...sections.keys()].filter((maker) => used.get(maker) !== 1),
  ];
  if (wrong.length > 0) throw new Error(`the engine's one text left out or doubled: ${wrong.join(", ")}`);
  out.splice(lastImport + 1, 0, ...unitImports);
  let text = out.join("\n");
  if (fields.size > 0) {
    text = text.replace(/\b(?:scope|box)\.([A-Za-z_$][\w$]*)/g, (whole, name: string) => (fields.has(name) ? name : whole));
    text = text.replace(/\b([A-Za-z_$][\w$]*): \1(?=,|\s*\}|\s*$)/gm, "$1");
  }
  return text;
}
