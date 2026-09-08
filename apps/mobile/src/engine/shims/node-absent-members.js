/**
 * WHAT EACH ABSENT MODULE WOULD HAVE EXPORTED — the member names, and nothing else.
 *
 * ── WHY A LIST EXISTS AT ALL, WHEN THE STUB ANSWERS EVERY NAME ────────────────────────────
 *
 * The stub in `node-absent.js` answers a refusing function for ANY property read, so a list of
 * names looks redundant. It is not, and the reason is the bundler. An ES import of a CommonJS
 * module is wired up by copying the module's OWN PROPERTY NAMES into a namespace object; a Proxy
 * over an empty target has none, so `import { join } from "node:path"` produced `undefined` and
 * the call failed as `(0, import_node_path.join) is not a function` — naming neither the module
 * nor the member, which is exactly what the stub was written to prevent. The names have to be
 * enumerable for the refusal to survive that copy.
 *
 * ── IT IS A MEASUREMENT, NOT A CURATED SET ────────────────────────────────────────────────
 *
 * Every list here is `Object.keys()` of the real module under the Node this repository runs.
 * Curating it would make the stub answer for the members somebody thought of, and `undefined` for
 * the rest — the same silent failure in a smaller place. `absent-shim-survives-interop.test.ts`
 * recomputes these lists from the running Node and fails when they differ, so a version that adds
 * or removes an export is a red rather than a guess.
 *
 * REGENERATE by running that test and reading what it reports; the shape below is the whole file.
 *
 * `fs` covers BOTH spellings the alias table routes to it (`fs` and `fs/promises` resolve to the
 * same stub), so its list is the union. A member of one that is missing from the other would
 * otherwise read as `undefined` on the half nobody enumerated.
 *
 * ── `omitted` IS A COUNT, NOT A LIST, AND IT IS THE ONE CONCESSION IN THIS FILE ──────────
 *
 * This file ships inside the phone app, whose privacy scan forbids the NAMES of browser transports
 * anywhere in shipped source. That rule is right: an app naming a transport outside its single
 * engine seam is how a second transport gets added, and a scan that tried to tell a mention from a
 * use by reading is a scan with an inline suppression bolted onto it within a week. One member of
 * `http` is such a name.
 *
 * So it is COUNTED here rather than written. The interop test is not shipped and may name them: it
 * recomputes the real export list, subtracts the tokens that rule forbids, and asserts what is left
 * is exactly what is below — so the omission is checked rather than trusted, and any drift in
 * either direction is red.
 *
 * THE COST, STATED PLAINLY: a named import of an omitted member would read as `undefined` rather
 * than refusing by name — the very defect this table exists to fix, for those members alone. The
 * interop test asserts the artifact contains no such import, which is what holds the cost at zero.
 */
"use strict";

module.exports = {
  fs: {
    from: ["node:fs","node:fs/promises"],
    members: ["Dir","Dirent","F_OK","FileReadStream","FileWriteStream","R_OK","ReadStream","Stats","W_OK","WriteStream","X_OK","_toUnixTimestamp","access","accessSync","appendFile","appendFileSync","chmod","chmodSync","chown","chownSync","close","closeSync","constants","copyFile","copyFileSync","cp","cpSync","createReadStream","createWriteStream","exists","existsSync","fchmod","fchmodSync","fchown","fchownSync","fdatasync","fdatasyncSync","fstat","fstatSync","fsync","fsyncSync","ftruncate","ftruncateSync","futimes","futimesSync","glob","globSync","lchmod","lchmodSync","lchown","lchownSync","link","linkSync","lstat","lstatSync","lutimes","lutimesSync","mkdir","mkdirSync","mkdtemp","mkdtempSync","open","openAsBlob","openSync","opendir","opendirSync","promises","read","readFile","readFileSync","readSync","readdir","readdirSync","readlink","readlinkSync","readv","readvSync","realpath","realpathSync","rename","renameSync","rm","rmSync","rmdir","rmdirSync","stat","statSync","statfs","statfsSync","symlink","symlinkSync","truncate","truncateSync","unlink","unlinkSync","unwatchFile","utimes","utimesSync","watch","watchFile","write","writeFile","writeFileSync","writeSync","writev","writevSync"],
    omitted: 0,
  },
  os: {
    from: ["node:os"],
    members: ["EOL","arch","availableParallelism","constants","cpus","devNull","endianness","freemem","getPriority","homedir","hostname","loadavg","machine","networkInterfaces","platform","release","setPriority","tmpdir","totalmem","type","uptime","userInfo","version"],
    omitted: 0,
  },
  path: {
    from: ["node:path"],
    members: ["_makeLong","basename","delimiter","dirname","extname","format","isAbsolute","join","matchesGlob","normalize","parse","posix","relative","resolve","sep","toNamespacedPath","win32"],
    omitted: 0,
  },
  http: {
    from: ["node:http"],
    members: ["Agent","ClientRequest","CloseEvent","IncomingMessage","METHODS","MessageEvent","OutgoingMessage","STATUS_CODES","Server","ServerResponse","_connectionListener","createServer","get","globalAgent","maxHeaderSize","request","setMaxIdleHTTPParsers","validateHeaderName","validateHeaderValue"],
    omitted: 1,
  },
  https: {
    from: ["node:https"],
    members: ["Agent","Server","createServer","get","globalAgent","request"],
    omitted: 0,
  },
  child_process: {
    from: ["node:child_process"],
    members: ["ChildProcess","_forkChild","exec","execFile","execFileSync","execSync","fork","spawn","spawnSync"],
    omitted: 0,
  },
  perf_hooks: {
    from: ["node:perf_hooks"],
    members: ["Performance","PerformanceEntry","PerformanceMark","PerformanceMeasure","PerformanceObserver","PerformanceObserverEntryList","PerformanceResourceTiming","constants","createHistogram","monitorEventLoopDelay","performance"],
    omitted: 0,
  },
};
