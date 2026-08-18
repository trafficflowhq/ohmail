#!/usr/bin/env node
/**
 * build-ui.mjs — `vite build`, with the artifact selected by a flag rather than by shell syntax.
 *
 * WHY THIS EXISTS AND IS NOT A ONE-LINE npm SCRIPT.
 *
 * The engine-bearing bundle is selected by `OHMAIL_LOCAL_ENGINE=1` (see vite.config.ts). The
 * obvious way to write that is a POSIX assignment prefix in package.json:
 *
 *     "ui:build:engine": "OHMAIL_LOCAL_ENGINE=1 vite build"
 *
 * and it is broken on Windows, which is one of the three platforms this app ships to. npm runs
 * scripts through the platform shell — `cmd.exe` there — and cmd has no assignment-prefix syntax:
 * it reads `OHMAIL_LOCAL_ENGINE=1` as the name of a program and fails with "is not recognized as
 * an internal or external command". Setting `shell: bash` in a CI job does not help, because the
 * shell npm uses for a script comes from npm's own `script-shell` config and not from the caller.
 *
 * The failure mode that made this worth a file: `set` in cmd would have made the script "work" and
 * silently produce the PREVIEW bundle inside a binary compiled with the engine feature — a window
 * with commands and no bridge, discovered by a person on Windows rather than by a build.
 *
 * No `cross-env` dependency: this app's manifest is published with the mirror and every entry in it
 * is a licence somebody has to read. Node can set an environment variable on its own.
 *
 * Vite's Node API rather than spawning its binary, because resolving `node_modules/.bin/vite`
 * differs between platforms too (`vite` vs `vite.cmd`) and spawning through a shell to paper over
 * that reintroduces exactly the quoting problem this file exists to remove. `build()` with no
 * arguments loads `vite.config.ts` from the working directory, which is what the command line does.
 *
 *   node scripts/build-ui.mjs                → the interface preview (fixtures, no engine)
 *   node scripts/build-ui.mjs --engine       → the bundle that belongs in a `--features local-engine` binary
 *   node scripts/build-ui.mjs --host-client  → the SERVED bundle the host door hands to a phone (dist-host)
 */
const engine = process.argv.includes("--engine");
const hostClient = process.argv.includes("--host-client");
if (engine && hostClient) {
  process.stderr.write("build-ui: --engine and --host-client select different artifacts — pass one\n");
  process.exit(1);
}
if (engine) process.env.OHMAIL_LOCAL_ENGINE = "1";
if (hostClient) process.env.OHMAIL_HOST_CLIENT = "1";

const { build } = await import("vite");
await build();
