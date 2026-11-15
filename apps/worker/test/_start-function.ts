import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE WORKER'S START FUNCTION, READ AS ONE TEXT. `startWorkerWithLock` (`src/index.ts`) is split into
 * sections (`src/start/*.ts`): each is called where it stood, and reaches what the sections share as
 * `scope.<name>`. The tests that read the start file as text were written against the function in one
 * piece. They read it through this, so each keeps its rule as it was written: every section's body
 * stands where its maker is called, the sections' import lines stand with the file's own, and the
 * `scope.` spelling is taken out.
 *
 * What it does not give back is a declaration the split turned into a field (`let stopped = false;`
 * reads `stopped = false;`). A rule that needs one fails here rather than passing on nothing.
 */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** The section files, in the order the start function calls them. */
export function startSectionFiles(): string[] {
  return [...readFileSync(`${SRC}index.ts`, "utf8").matchAll(/^    (\w+)Section\(scope\);$/gm)]
    .map((m) => `start/${m[1]!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.ts`);
}

export function startFunctionSource(): string {
  const out: string[] = [];
  const imports: string[] = [];
  for (const line of readFileSync(`${SRC}index.ts`, "utf8").split("\n")) {
    const call = /^    (\w+)Section\(scope\);$/.exec(line);
    if (!call) { out.push(line); continue; }
    const file = call[1]!.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const moved = readFileSync(`${SRC}start/${file}.ts`, "utf8").split("\n");
    const open = moved.findIndex((l) => l.startsWith(`export function ${call[1]}Section(scope: WorkerScope)`));
    const close = moved.lastIndexOf("}");
    if (open < 0 || close <= open) throw new Error(`start/${file}.ts is not a section the start function calls`);
    // Its imports, as the start file would spell them; the two of its own folder are the split's.
    const head = moved.slice(0, open).join("\n").split(/(?<=;)\n/)
      .filter((stmt) => stmt.startsWith("import") && !/from "\.\/scope\.js";$|from "\.\.\/index\.js";$/.test(stmt));
    imports.push(...head.map((stmt) => stmt.replace(/from "\.\.\//, 'from "./')));
    out.push(...moved.slice(open + 1, close).filter((l) => !/^    const \{ \w+ \} = scope;$/.test(l)));
  }
  const lastImport = out.reduce((at, l, i) => (/^(import |\} from ")/.test(l) ? i : at), 0);
  out.splice(lastImport + 1, 0, ...imports);
  // `{ db }` is spelled `{ db: scope.db }` in a section: a property whose value is its own name off the
  // scope, and nothing after it, was the short form.
  return out.join("\n").replace(/\b(\w+): scope\.\1(?=\s*[,}])/g, "$1").replace(/\bscope\./g, "");
}

const INDEX = `${SRC}index.ts`;
const START = `${SRC}start/`;

/**
 * A source file as a test that reads source as text reads it: the start file in one piece
 * ({@link startFunctionSource}), its section files empty (their text is in the start file's, where a
 * rule written against the one function expects it), and any other file as it is.
 */
export function readSource(path: string | URL): string {
  const abs = resolve(typeof path === "string" ? path : fileURLToPath(path));
  if (abs === INDEX) return startFunctionSource();
  if (abs.startsWith(START) && abs.endsWith(".ts")) return "";
  return readFileSync(abs, "utf8");
}
