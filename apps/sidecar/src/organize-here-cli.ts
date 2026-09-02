/**
 * THE `organize-here` COMMAND'S ENTRY POINT — and the reason it is a file of its own.
 *
 *   pnpm -F @ohmail/sidecar organize-here
 *
 * The command's logic lives in `organize-here.ts`, which is a LIBRARY: the engine imports
 * `requestOrganizerTakeover` from it to serve the in-app "organize from this machine" button.
 * This file holds the half that RUNS — the `import.meta.url === argv[1]` guard and the
 * `process.exit` that follows it — and nothing the engine imports may reach it.
 *
 * ── WHY THE SPLIT IS LOAD-BEARING, NOT TIDINESS ───────────────────────────────────────────
 *
 * The engine ships as ONE bundled file. A bundler rewrites every module's `import.meta.url` to
 * the URL of the OUTPUT it produced, so inside the bundle every module claims to be the file the
 * user ran — and a `import.meta.url === argv[1]` entry guard, which is exactly how a Node module
 * asks "was I run directly?", is therefore TRUE for every module that carries one.
 *
 * When such a guard sat at the bottom of the library half, the engine ran this command on every
 * launch. It opened the local database and took the data directory's exclusive lock before the
 * engine's own startup could, so startup then refused — correctly, since that lock exists to stop
 * two writers on one mirror — and the engine never served. On the success path it would instead
 * have called `process.exit`, ending the engine at launch.
 *
 * So the rule this file exists to keep is: **an entry guard belongs only in a module that nothing
 * bundled imports.** A library that is importable and self-executing is a library that executes
 * inside whatever imports it.
 */
import { runOrganizeHere } from "./organize-here.js";

void runOrganizeHere().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
