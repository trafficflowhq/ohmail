/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE ONE ALIAS TABLE — what the mail engine's imports resolve to when it is built for a phone
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ONE consumer reads it: the script that builds the phone bundle. The censuses over that bundle
 * read the BUILT ARTIFACT instead, which is the whole point — a census over this table would only
 * prove the table says what it says.
 *
 * ── AND THE APP'S BUNDLER NEEDS NOTHING FROM IT, WHICH WAS MEASURED RATHER THAN PLANNED ───
 *
 * The design this implements expected a second copy of the table in the phone app's Metro config,
 * so the app's own resolver would answer the same names the same way. It does not need one: the
 * engine is PRE-BUNDLED here with every specifier resolved, and the artifact leaves exactly TWO
 * requires behind — `react-native-tcp-socket` and `react-native-quick-crypto`, both ordinary
 * packages that Metro resolves without help. The census asserts that count, which is what keeps it
 * true; a third external would be a native dependency nobody decided to add, and the census names
 * it rather than a bundler quietly failing to find it on a device.
 *
 * So there is one table and one reader, and the drift this file was written to prevent cannot
 * happen because there is nothing to drift from.
 *
 * ── IT LIVES HERE, BESIDE THE SUBSTITUTES IT NAMES, AND NOT IN THE PHONE APP ──────────────
 *
 * It was written at the app's root first, and that app's own privacy census refused it: the table
 * has to name a workspace package by its scope, and the scan forbids that string anywhere under
 * `apps/mobile` — because a phone app naming the server workspace is the beginning of depending on
 * it. The refusal was right, and the answer is not an exemption: this table describes how the
 * ENGINE is bundled, the engine is this package's, and the modules it substitutes are the files
 * next to it. The app's Metro config reads it from here.
 *
 * A table with two copies is a table that disagrees with itself, and the failure it produces is the
 * worst-shaped one available: a bundle that builds, ships, and reaches `require('fs')` at load on a
 * device. That is a listed risk of this whole design ("a Metro alias missing ⇒ `require('fs')` at
 * load"), and one file is the answer to it.
 *
 *
 * ── WHY THE TABLE IS LOAD-BEARING FOR A SAFETY PROPERTY, NOT JUST FOR A BUILD ─────────────
 *
 * The phone must not be a host and must not touch our servers with a person's mail. Some of what
 * enforces that is composition, and some of it is this table: the desktop's host door, its
 * same-network door and its local Postgres are not merely unused in the phone's build, they are
 * SUBSTITUTED, so the artifact does not contain them. That makes an entry going missing here a
 * privacy question and not a packaging one — which is why `engine-aliases.test.ts` asserts every
 * row resolves to a file that exists, that every substituted module is real in the desktop's graph
 * (a row naming nothing would silently substitute nothing), and why the metafile census is a
 * separate check over the built artifact rather than a reading of this file.
 */
/* ESM, because this package is `"type": "module"`. Its one reader is an ESM script. */
import path from "node:path";
import { fileURLToPath } from "node:url";

const PHONE = path.dirname(fileURLToPath(import.meta.url));  // apps/sidecar/src/phone
const REPO = path.resolve(PHONE, "..", "..", "..", "..");
const MOBILE = path.join(REPO, "apps", "mobile");
const SHIMS = path.join(MOBILE, "src", "engine", "shims");

/** `readable-stream`'s own promise surface — `stream/promises` has no separate package. */
const READABLE_STREAM_PROMISES = "readable-stream/lib/stream/promises.js";

/**
 * NODE BUILTINS, by bare specifier. Both spellings of each — `fs` and `node:fs` — because the
 * engine's own code writes the prefixed form and its dependencies write the bare one, and a table
 * covering one of them leaves the other resolving to a builtin that is not there.
 *
 * The value is either a PACKAGE (resolved by the bundler from the app's own dependencies) or an
 * absolute path into `src/engine/shims`. Nothing here is a bare `false` or an empty module: a
 * silently empty builtin is how a library gets an object with no methods and fails later, with a
 * stack that names neither the module nor this table.
 */
const NODE_MODULES = {
  // ── PROVIDED, and these are the ones the engine genuinely uses ────────────────────────────
  crypto: "react-native-quick-crypto",
  /* THE POLYFILL, WRAPPED — see `shims/buffer.js`. The package has no `base64url`, which sealing a
     mailbox credential writes, and one of its members answers a WRONG LENGTH for that name rather
     than refusing. The shim requires the package by its own `buffer/` spelling, which this table
     does not match (rule 2 is the bare name, exactly), so there is still exactly one copy of it in
     the artifact — asserted by the bundle census. */
  buffer: path.join(SHIMS, "buffer.js"),
  events: "events",
  util: "util",
  stream: "readable-stream",
  "stream/promises": READABLE_STREAM_PROMISES,
  string_decoder: "string_decoder",
  net: path.join(SHIMS, "net.js"),
  tls: path.join(SHIMS, "tls.js"),
  url: path.join(SHIMS, "url.js"),

  // ── REFUSED, each for a reason its own file states ────────────────────────────────────────
  zlib: path.join(SHIMS, "zlib.js"),
  dns: path.join(SHIMS, "dns.js"),
  "dns/promises": path.join(SHIMS, "dns.js"),
  fs: path.join(SHIMS, "node-fs.js"),
  "fs/promises": path.join(SHIMS, "node-fs.js"),
  os: path.join(SHIMS, "node-os.js"),
  path: path.join(SHIMS, "node-path.js"),
  http: path.join(SHIMS, "node-http.js"),
  https: path.join(SHIMS, "node-https.js"),
  child_process: path.join(SHIMS, "node-child_process.js"),
  /* `perf_hooks` is reached ONLY by the Postgres wire driver, which has no business in this bundle
     at all — see the census's named exception. Refused rather than provided, so that if the driver
     ever does execute here it fails at the line that needed a server's timing rather than quietly
     measuring nothing. */
  perf_hooks: path.join(SHIMS, "node-perf_hooks.js"),
};

/** Non-builtin packages the engine reaches that also have no place on a phone. */
const PACKAGE_ALIASES = {
  /* `imapflow` requires this at module scope for its proxy connector and calls it only for a
     configured proxy, which nothing here can configure. */
  socks: path.join(SHIMS, "socks.js"),
  /* `imapflow/lib/logger.js` calls `require('pino')()` AT LOAD whether or not logging is on. */
  pino: path.join(SHIMS, "pino.js"),
};

/**
 * THE DESKTOP'S OWN MODULES, by the specifier written INSIDE `apps/sidecar/src`.
 *
 * Keyed by the literal relative specifier because that is what a resolver sees, and anchored
 * exactly: a looser pattern would rewrite the same name imported from somewhere else. Each value
 * is a file in `apps/sidecar/src/phone`, whose README states the rule they are all held to — a
 * substitute for something CALLED AT BOOT answers, and only an unreachable one refuses.
 */
const SIDECAR_SUBSTITUTES = {
  /* `createSidecar` builds a local AI provider unconditionally, and the real one opens a store
     file through `path.join` at the top of that call — so the engine died during composition on a
     build that does not offer the feature at all. The twin answers the same interface with no disk
     and no network, and substituting it here takes three vendor transports out of the artifact as
     well. See `phone/ai-provider.ts`. */
  "./ai-provider.js": path.join(PHONE, "ai-provider.ts"),
  "./db.js": path.join(PHONE, "db.ts"),
  "./host-listener.js": path.join(PHONE, "host-listener.ts"),
  "./host-lan.js": path.join(PHONE, "host-lan.ts"),
  "./host-lan-tls.js": path.join(PHONE, "host-lan-tls.ts"),
  "./host-static.js": path.join(PHONE, "host-static.ts"),
  "./host-pair-routes.js": path.join(PHONE, "host-pair-routes.ts"),
  "./lan-routes.js": path.join(PHONE, "lan-routes.ts"),
};

/**
 * THE SCHEMA TWIN, substituted at the module the BARREL itself reaches.
 *
 * Counted over the engine-closure files that carry a construct the two stores spell differently:
 * thirty-eight import their tables from the `@trafficflow/db` barrel, eight more inside
 * `packages/db/src` import `./schema-mail.js` by relative path, and exactly ONE imports
 * `@trafficflow/db/mail` — a sidecar module this build drops anyway. So swapping that one specifier
 * would substitute the schema for one file in forty and leave every service running the device
 * store's statements against the server's column types.
 *
 * Rewriting `./schema-mail.js`, which `packages/db/src/index.ts` and `schema.ts` both use, serves
 * the twin to all of them without editing a line of any. The specifier is ANCHORED for a measured
 * reason: a whole-path pattern also rewrites `../src/schema-mail.js`, which is how the parity test
 * reaches the SERVER twin — and it substitutes silently, leaving that test comparing the device
 * twin with itself.
 */
const SCHEMA_TWIN = {
  from: "./schema-mail.js",
  to: path.join(REPO, "packages", "db", "src", "schema-mail-sqlite.ts"),
};

/** The route table a paired phone reaches on a HOSTING desktop. Empty here. */
const API_SUBSTITUTES = {
  "@trafficflow/api/desktop-host": path.join(PHONE, "desktop-host.ts"),
};

/**
 * THE TWO NATIVE MODULES THE BUNDLE DOES NOT CONTAIN.
 *
 * Left as `require`s for the app's own bundler to resolve, because they are native: their
 * JavaScript is meaningless without the compiled library beside it. Two, and the census asserts
 * exactly two — a third external is a native dependency nobody decided to add.
 */
const EXTERNAL = ["react-native-tcp-socket", "react-native-quick-crypto"];

/**
 * WHAT THE BUNDLER MUST BIND AS GLOBALS, and the first of the two is not the same problem as the
 * `buffer` alias above.
 *
 * Aliasing the MODULE fixes code that imports it. Mail parsing is full of `Buffer.from` written
 * against the GLOBAL, and the runtime answers `ReferenceError: Property 'Buffer' doesn't exist`
 * from inside a drain — nowhere near anything that names a polyfill. Binding it at bundle time is
 * what makes it independent of load order.
 */
const INJECT = [path.join(SHIMS, "globals.mjs")];

/** Every bare specifier the table answers, in both spellings. */
function bareSpecifiers() {
  const out = {};
  for (const [name, target] of Object.entries(NODE_MODULES)) {
    out[name] = target;
    out[`node:${name}`] = target;
  }
  for (const [name, target] of Object.entries(PACKAGE_ALIASES)) out[name] = target;
  for (const [name, target] of Object.entries(API_SUBSTITUTES)) out[name] = target;
  return out;
}

export {
  MOBILE, REPO, SHIMS, PHONE,
  NODE_MODULES, PACKAGE_ALIASES, SIDECAR_SUBSTITUTES, API_SUBSTITUTES, SCHEMA_TWIN,
  EXTERNAL, INJECT, bareSpecifiers,
};
export default {
  MOBILE, REPO, SHIMS, PHONE,
  NODE_MODULES, PACKAGE_ALIASES, SIDECAR_SUBSTITUTES, API_SUBSTITUTES, SCHEMA_TWIN,
  EXTERNAL, INJECT, bareSpecifiers,
};
