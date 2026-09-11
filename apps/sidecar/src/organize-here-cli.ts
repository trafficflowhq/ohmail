/**
 * The `organize-here` command's entry point — and why it is a file of its own. The logic lives in
 * `organize-here.ts`, a LIBRARY the engine imports (`requestOrganizerTakeover` serves the in-app
 * button); this file holds the half that RUNS — the `import.meta.url === argv[1]` guard and the
 * `process.exit` — and nothing the engine imports may reach it. The split is load-bearing: the engine
 * ships as ONE bundled file, and a bundler rewrites every module's `import.meta.url` to the output's,
 * so an entry guard is TRUE for every module carrying one. When such a guard sat in the library half,
 * the engine ran this command every launch, took the data directory's exclusive lock before startup
 * could, and served nothing. The rule: an entry guard belongs only in a module nothing bundled imports.
 */
import { runOrganizeHere } from "./organize-here.js";

void runOrganizeHere().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
