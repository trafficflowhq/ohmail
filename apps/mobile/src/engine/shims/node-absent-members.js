/**
 * What each absent module would have exported — the member names, and nothing else. The stub
 * answers any property read, but the bundler wires an ES import of CommonJS by copying the
 * module's OWN property names — a Proxy over an empty target has none, so
 * `import { join } from "node:path"` produced `undefined`, naming neither module nor member.
 * A measurement, not a curated set: every list is `Object.keys()` of the real module, and
 * `absent-shim-survives-interop.test.ts` recomputes them and fails on drift; `fs` is the union of both spellings. `omitted` is a count, not a list: the privacy scan forbids browser
 * transport names in shipped source, so the one such member of `http` is counted here and
 * named only in the unshipped interop test, which asserts the artifact never imports it.
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
