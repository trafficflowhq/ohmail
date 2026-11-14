import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DOOR = fileURLToPath(new URL("../../src/engine.ts", import.meta.url));
const FOLDER = fileURLToPath(new URL("../../src/engine", import.meta.url));

/** The engine's files: its door `src/engine.ts`, then every file of `src/engine/` by name. */
export function engineFiles(): string[] {
  return [DOOR, ...readdirSync(FOLDER).filter((n) => n.endsWith(".ts")).sort().map((n) => join(FOLDER, n))];
}

/** Their text as one: a census of the engine reads all of it, whichever file a method stands in. */
export const engineSource = (): string => engineFiles().map((f) => readFileSync(f, "utf8")).join("\n");
