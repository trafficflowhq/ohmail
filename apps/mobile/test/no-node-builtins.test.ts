/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PHONE'S ENGINE BUNDLE, CENSUSED — over the artifact, never over the alias table
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The engine that organizes mail on a phone is pre-bundled from the same sources the desktop runs.
 * Three properties of the ARTIFACT are what make that safe, and none of them can be established by
 * reading a configuration file:
 *
 *  1. **No Node builtin survives.** A phone has no `fs`, no `os`, no `http`. An unaliased builtin
 *     is not a degraded feature, it is `require('fs')` at load on a device — the listed risk of
 *     this whole design.
 *  2. **No host module, and no desktop store.** The phone is never a host: it serves no door to
 *     another device and never becomes one. Some of that is composition, and some of it is that
 *     the code for a door is NOT IN THE FILE. Same for the desktop's local Postgres.
 *  3. **Exactly two things left the bundle**, both native modules the app resolves itself. A third
 *     external is a native dependency nobody decided to add, and it would fail on a device rather
 *     than here.
 *
 * ── WHY THE METAFILE AND NOT THE TABLE ────────────────────────────────────────────────────
 *
 * A census over the alias table would prove the table says what it says. This repository has paid
 * for that distinction once already, on the desktop engine: its schema census read a metafile that
 * the builder itself would have REFUSED to write, so every reading of it measured an artifact
 * nobody shipped. The census therefore reads the graph, and asserts the graph is FRESH.
 *
 * ── THE INHERITED EXCEPTIONS ARE NAMED, PINNED, AND EXPIRE ────────────────────────────────
 *
 * Inputs are in this bundle that should not be, and every one of them arrives through a BARREL edge
 * in a shared package rather than through anything this build does. They are pinned by group AND by
 * total, so a set can only SHRINK and a group nobody enumerated cannot hide behind four correct
 * counts — which is not hypothetical: this block was written with three groups and the floor
 * assertion found five more files. Each names what removes it, because an exception with no expiry
 * is a permission slip.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BUNDLE, IMAPFLOW_REARM_MARKER, METAFILE, OUT_DIR, nodeSpecifiersIn, externalsIn, REPO, builtCopiesIn,
  selectedExportTargets, workspaceExportTargets,
} from "../scripts/bundle-engine.mjs";
import { requiresIn } from "../scripts/verify-phone-engine-repro.mjs";

interface Metafile {
  inputs: Record<string, { bytes: number; imports?: { path: string; external?: boolean; original?: string }[] }>;
}

/**
 * THE ARTIFACT, BUILT WHEN IT IS ABSENT OR STALE — never skipped, and never refused for want of a
 * toolchain.
 *
 * The first version read `OHMAIL_ESBUILD_FROM` and REFUSED without it, which is every ordinary run
 * of this suite: a gate firing on innocent runs, which discards other people's work exactly as
 * surely as a gate that cannot fire lets it through. The builder now acquires the pinned bundler
 * through the same shared, atomic, version-keyed installer the desktop engine's own census uses, so
 * "I cannot build" is a real failure rather than a missing environment variable.
 *
 * Stale is treated as absent, and that is the important half: a metafile older than the sources it
 * is a census of describes an artifact nobody would ship. This repository has already paid for that
 * once — the desktop engine's census read a metafile the builder itself would have REFUSED to
 * write, so every reading of it measured something that never existed.
 */
function metafile(): Metafile {
  if (!existsSync(METAFILE) || statSync(METAFILE).mtimeMs < newestSourceTime()) {
    execFileSync(process.execPath, [join(REPO, "apps", "mobile", "scripts", "bundle-engine.mjs")], {
      cwd: REPO, stdio: "pipe", env: { ...process.env, CI: "true" },
    });
  }
  return JSON.parse(readFileSync(METAFILE, "utf8")) as Metafile;
}

/** The newest mtime across the things a rebuild would change. Cheap, and enough to catch staleness. */
function newestSourceTime(): number {
  const watched = [
    join(REPO, "apps", "sidecar", "src", "mobile.ts"),
    join(REPO, "apps", "sidecar", "src", "engine.ts"),
    join(REPO, "apps", "sidecar", "src", "phone", "aliases.js"),
    join(REPO, "apps", "mobile", "src", "engine", "shims"),
  ];
  let newest = 0;
  for (const p of watched) {
    if (!existsSync(p)) continue;
    newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

const meta = metafile();
const inputs = Object.keys(meta.inputs);

/** By package DIRECTORY, never by the pnpm directory name. See the note on the pglite trap below. */
const inPackage = (pkg: string) => (p: string) => p.startsWith(`node_modules/${pkg}/`) || p.includes(`/node_modules/${pkg}/`);
const count = (pred: (p: string) => boolean) => inputs.filter(pred).length;
const list = (pred: (p: string) => boolean) => inputs.filter(pred).sort();

describe("the phone engine bundle reaches no Node builtin", () => {
  it("carries not one `node:` specifier", () => {
    // The build itself also refuses this — it runs on a NEUTRAL platform, where an unaliased
    // builtin is a build error naming the file that imported it. Asserted again here because a
    // build can be run with different options and a test cannot.
    expect(nodeSpecifiersIn(meta)).toEqual([]);
  });

  it("left exactly the two native modules for the app to resolve", () => {
    // What a device is asked for is the `require` in the bytes. esbuild's own externals list also
    // counts imports it erased (type-only, in a tree whose workspace subpaths resolve to source), so it
    // is read as a superset: everything the artifact requires is on it, and nothing else is required.
    const asked = requiresIn(readFileSync(BUNDLE, "utf8"));
    expect(asked).toEqual(["react-native-quick-crypto", "react-native-tcp-socket"]);
    expect(externalsIn(meta)).toEqual(expect.arrayContaining(asked));
    expect(requiresIn('x(require("fs")); require("react-native-tcp-socket");'), "the control: a third one is read").toEqual(["fs", "react-native-tcp-socket"]);
  });

  it("censused a real graph, not a handful of seeds", () => {
    // A resolver that stopped matching would reach almost nothing and report a clean result. These
    // are floors, not fits, and the sizes they are floors UNDER are deliberately not written here:
    // the figure moved three times (a vendor provider substituted out, the journal off the package
    // barrel, the private barrel leafed) and a number in a comment is a claim nobody checks. The
    // run prints what it measured.
    expect(inputs.length).toBeGreaterThan(600);
    expect(count((p) => p.startsWith("apps/") || p.startsWith("packages/"))).toBeGreaterThan(200);
    // And it is the ENGINE: the worker's sync loop and the local route table are in it.
    expect(list((p) => p.includes("apps/worker/src/sync")).length).toBe(1);
    expect(count((p) => /packages\/api\/(dist|src)\/local/.test(p))).toBeGreaterThan(0);
  });
});

describe("the phone engine bundle contains no door and no desktop store", () => {
  it("has none of the desktop's host or same-network modules", () => {
    // The eight substitutes are what the graph holds instead, asserted below.
    const desktopOnly = list((p) =>
      /apps\/sidecar\/(src|dist)\/(host|lan-routes|http-host)/.test(p) && !p.includes("/phone/"));
    expect(desktopOnly).toEqual([]);
  });

  it("has no desktop-host route table", () => {
    expect(list((p) => /(routes\/)?desktop-host/.test(p) && !p.includes("/phone/"))).toEqual([]);
  });

  it("has no local Postgres — and this is checked by package DIRECTORY, not by the pnpm name", () => {
    // THE TRAP, in the mirror of the one the desktop's builder documents: pnpm's directory name for
    // `drizzle-orm` embeds its recorded peers, so it literally contains `pglite@0.2.17`. A substring
    // match on "pglite" reports 142 hits here, every one of them an ordinary drizzle file. Matching
    // the package directory reports the truth, which is none.
    expect(list(inPackage("@electric-sql/pglite"))).toEqual([]);
    // The matcher reads real package directories: the drizzle files the trap would have counted are found by theirs.
    expect(list(inPackage("drizzle-orm")).length).toBeGreaterThan(0);
  });

  it("has neither the desktop's store module nor the server's schema twin", () => {
    expect(list((p) => /apps\/sidecar\/(src|dist)\/db\.(ts|js)$/.test(p))).toEqual([]);
    expect(list((p) => /packages\/db\/(src|dist)\/schema-mail\.(ts|js)$/.test(p))).toEqual([]);
    // And the DEVICE twin is there instead — the substitution at the module the barrel reaches.
    expect(list((p) => p.includes("schema-mail-sqlite")).length).toBe(1);
    // With the device store's own binding.
    expect(count((p) => p.includes("drizzle-orm/sqlite-proxy/"))).toBeGreaterThan(0);
  });

  it("holds the phone's substitutes instead — all seventeen of them", () => {
    const substitutes = list((p) => p.includes("apps/sidecar/src/phone/"))
      .map((p) => p.split("/").pop());
    // `store-lanes.ts` joined the table with the desktop's store scheduler: it names its two lanes
    // with `AsyncLocalStorage`, and `node:async_hooks` on a phone is a crash at load. The list is
    // exact on purpose — a row that stops being substituted has to be a red here, not a silence.
    // `cloud-probe.ts` joined it with the pairing check both desktop engines serve (`node:tls`), the
    // three workspace twins with the Postgres schema markers, dialect and event stream, and
    // `attachment-file-route.ts` with the desktop's streamed save (a file the shell names; a phone names none),
    // `blank-repair.ts` and `blank-rows.ts` with the blank repair the phone composes off.
    expect(substitutes.sort()).toEqual([
      "ai-provider.ts", "attachment-file-route.ts", "blank-repair.ts", "blank-rows.ts", "cloud-probe.ts", "db.ts", "desktop-host.ts", "dialect-pg.ts",
      "events.ts", "health-markers.ts", "host-lan-tls.ts", "host-lan.ts", "host-listener.ts", "host-pair-routes.ts",
      "host-static.ts", "lan-routes.ts", "store-lanes.ts",
    ]);
  });

  /**
   * THE AI PROVIDER IS THE PHONE'S, AND THE THREE VENDOR TRANSPORTS LEFT WITH IT.
   *
   * The desktop's provider opens a store file through `path.join` on its first line, which on a
   * phone is a module that is not there — so the engine died while composing itself, over a feature
   * this build does not offer. Substituting it is also the reason the code that talks to two hosted
   * AI vendors and to a local model server is no longer in an artifact whose claim is that it is
   * not there: it was reachable only through that provider's own imports.
   */
  it("has the phone's AI provider and none of the vendor transports", () => {
    expect(list((p) => /apps\/sidecar\/(src|dist)\/ai-provider\.(ts|js)$/.test(p))).toEqual([]);
    expect(list((p) => p.includes("apps/sidecar/src/phone/ai-provider"))).toHaveLength(1);
    for (const transport of ["ai-anthropic", "ai-openai", "ai-ollama", "ai-opencode-go", "ai-transport"]) {
      expect(list((p) => p.includes(transport)), transport).toEqual([]);
    }
  });

  /**
   * THE MIGRATION JOURNAL WITHOUT THE PACKAGE BARREL THAT COMPUTES DIRECTORIES.
   *
   * That barrel works out two directory paths at module scope from an address helper the phone
   * substitutes with one that refuses by name — so the artifact threw while still initialising,
   * before the function an app calls to start it existed. Nothing had asked for a directory.
   */
  it("reaches the journal leaf and not the barrel that computes directories", () => {
    expect(list((p) => /packages\/db-mail\/(src|dist)\/index\.(ts|js)$/.test(p))).toEqual([]);
    expect(list((p) => p.includes("db-mail/") && p.includes("sqlite-journal"))).toHaveLength(1);
  });

  /**
   * EXACTLY ONE COPY OF THE BINARY-DATA POLYFILL.
   *
   * The shim that adds the URL-safe base64 encoding patches the polyfill's own class IN PLACE, so
   * that the class bound as a global and the class a module imports are one thing. That is only
   * true while there is one copy: the shim requires the package by its own trailing-slash spelling,
   * which the alias table (bare name, exactly) does not match. A second copy would leave mail
   * parsing writing against an unpatched class.
   */
  it("carries one copy of the binary-data polyfill, and the shim that wraps it", () => {
    expect(list((p) => /node_modules\/buffer\//.test(p))).toHaveLength(1);
    expect(list((p) => p.endsWith("shims/buffer.js"))).toHaveLength(1);
  });

  it("holds the shims, and the injected globals module among them", () => {
    const shims = list((p) => p.includes("apps/mobile/src/engine/shims/"));
    expect(shims.length).toBeGreaterThan(12);
    // The `Buffer` global is bound at bundle time, not by an alias — a module alias reaches only
    // code that imports it, and mail parsing writes `Buffer.from` against the global.
    expect(shims.some((p) => p.endsWith("globals.mjs"))).toBe(true);
  });

  /**
   * ONE `process`, AND ITS `nextTick` IS NO TIMER (PERF-026). readable-stream requires `process/`
   * by name; unaliased that is `process@0.11.10/browser.js`, whose `nextTick` schedules a 0 ms
   * timer — about seventeen serial timer turns per message parsed, the bulk of a phone's first
   * sync (a timer waits for a frame on Android). Read off the graph and off the shipped bytes.
   */
  it("bundles the shim's `process` and no timer-backed `nextTick`", () => {
    expect(list((p) => /node_modules\/process\//.test(p)), "the npm process polyfill came back").toEqual([]);
    expect(list((p) => p.endsWith("shims/process.js"))).toHaveLength(1);
    const readers = Object.entries(meta.inputs)
      .filter(([p]) => /readable-stream\/lib\/internal\/streams\/readable\.js$/.test(p))
      .flatMap(([, v]) => (v.imports ?? []).filter((i) => i.original === "process/").map((i) => i.path));
    expect(readers, "readable-stream's `process/` resolved somewhere else").toEqual([
      expect.stringMatching(/apps\/mobile\/src\/engine\/shims\/process\.js$/),
    ]);
    const bundled = readFileSync(BUNDLE, "utf8");
    expect(bundled.includes("runTimeout(drainQueue)"), "a timer-backed nextTick is in the artifact").toBe(false);
  });

  /* AND IMAPFLOW'S READER IS RE-ARMED IN THIS BUNDLE, its microtask scheduler being the gap's cause;
     the other engines load upstream (`test/imapflow-upstream-outside-the-phone.test.ts`). */
  it("carries imapflow's re-armed reader, once", () => {
    const bundled = readFileSync(BUNDLE, "utf8");
    expect(bundled.split(IMAPFLOW_REARM_MARKER).length - 1).toBe(1);
  });
});

/**
 * ── THE INHERITED EXCEPTION: ONE IMPORT, TWENTY-FOUR INPUTS ──────────────────────────────
 *
 * This bundle carries the private half — the Postgres wire driver, the model runtime, and the
 * billing, admin, staff and Cloud-schema modules. None of it arrives through anything this build
 * does. It arrives through a single VALUE import of the private half's barrel from
 * the AI workflow runner module in core, which conveys everything that barrel re-exports.
 *
 * **It is the same edge, at the same size, that the desktop engine's own builder refuses.** That
 * builder counted 24 private/provisioning inputs at this base; this bundle carries 24, and the four
 * groups below account for all of them. Two independent bundles of the same sources reaching the
 * same number is what makes this one edge rather than a family of them — and it is why the fix is
 * upstream (a separate change on the main line leafs both edges) rather than anything to do here.
 *
 * ── THE EXIT CONDITION THIS BLOCK NAMED HAS BEEN MET ─────────────────────────────────────
 *
 * "Re-stacking onto a base that carries that fix removes all 24" — it does. Measured on the
 * bundle this landing builds: every one of the four groups is ZERO, and the graph is otherwise
 * unchanged, so the pins are gone and the assertion is the stronger one they were standing in for.
 *
 * The zeros are a MEASUREMENT and not an empty read, which matters because an empty read is the
 * failure mode this whole file is built against: the floors below pass on the same metafile in the
 * same run — hundreds of inputs, many of them this repository's, the local route table, PGlite
 * and the sqlite proxy all present — so the resolver is reaching the graph and finding none of
 * the private half in it.
 *
 * The two cases stay rather than being deleted with the exception, and they say different things:
 * the first NAMES which group came back, the second catches any group at all — including one
 * nobody enumerated, which is how this block was written wrong the first time (the floor found
 * `billing`, `admin-db`, `cloud`, `schema-cloud` and `staff-grants` that three listed groups did
 * not cover). Either firing means a value import of the private barrel has returned.
 */
describe("the private half in this bundle — the inherited exception, now expired", () => {
  const POSTGRES = count(inPackage("postgres"));
  const POSTGRES_JS = count((p) => p.includes("drizzle-orm/postgres-js/"));
  const MODEL_RUNTIME = count((p) => /packages\/core\/(src|dist)\/ai\//.test(p));
  const DB_PRIVATE = count((p) =>
    /packages\/db\/(src|dist)\/(billing|admin|admin-db|staff-grants|schema-cloud|cloud)\.(ts|js)$/.test(p));

  it("carries none of the four groups — named, so a red says WHICH came back", () => {
    expect({ POSTGRES, POSTGRES_JS, MODEL_RUNTIME, DB_PRIVATE })
      .toEqual({ POSTGRES: 0, POSTGRES_JS: 0, MODEL_RUNTIME: 0, DB_PRIVATE: 0 });
  });

  it("and none of it at all — the total, which also catches a group nobody enumerated", () => {
    // Not a duplicate of the case above: that one can only see the four groups it lists, and a
    // fifth would pass it. This one is the arithmetic, and it was pinned for exactly that reason.
    expect(POSTGRES + POSTGRES_JS + MODEL_RUNTIME + DB_PRIVATE).toBe(0);
  });

  /**
   * TWO PINNED-FETCH MODULES, AND EACH IMPORTER IS CLASSIFIED — a different edge from the 24.
   *
   * The count alone was the first version of this and it was not enough: "two" says nothing about
   * whether either is reachable by a person. Classified by who imports them:
   *
   *  · `core/net/pinned-fetch` ← the `core/net` BARREL ← a service's SSRF guard. A leafing owed in
   *    the package that owns the barrel, and it lands at the dialect lane's own rebase — which is
   *    what expires this row.
   *  · `services/pinned-fetch` ← TWO importers, not the one the ruling's amendment names:
   *      – `privacy-service` (its image proxy) is a PERMANENT server-only entry, beside the
   *        migration-journal and schema-catalog modules a device never runs. Unreachable here.
   *      – `unsubscribe-service` is REACHABLE, and that is the finding: the engine composes
   *        one-click unsubscribe, and without an arm for it a tap reaches `node:http` — a thrower.
   *        The composition now passes a refusal that names itself, and the real wiring plus the
   *        question of what an SSRF gate means on a device belong to the door's own slice.
   */
  it("two pinned-fetch modules, and both importers of the services one are named", () => {
    expect(count((p) => p.includes("pinned-fetch"))).toBe(2);

    /* Resolved against the metafile's own INPUT KEYS rather than against a guessed path shape.
       Written as a substring of "services/pinned-fetch" first, it matched nothing and reported an
       empty importer list — the metafile records the services package's built pinned-fetch module, and a
       census that answers "nobody imports it" because its needle is wrong is the shape this whole
       file exists to avoid. */
    const importersOf = (targetKey: string): string[] => {
      const found = new Set<string>();
      for (const [file, input] of Object.entries(meta.inputs)) {
        for (const imported of input.imports ?? []) {
          if (imported.path === targetKey) found.add(file);
        }
      }
      return [...found].sort();
    };
    const keyFor = (pkg: string): string => {
      const hits = inputs.filter((p) => p.includes(`${pkg}/`) && p.includes("pinned-fetch"));
      expect(hits, `one ${pkg} pinned-fetch input`).toHaveLength(1);
      return hits[0]!;
    };

    // The classification is the assertion: a THIRD importer appearing here is a new path to an
    // HTTP client on a phone, and it must be classified before it ships rather than after.
    // By module, not by extension: a workspace module is reached as its source or as its built copy.
    const moduleName = (p: string) => p.split("/").pop()!.replace(/\.(?:ts|js)$/, "");
    const services = importersOf(keyFor("services")).map(moduleName);
    expect(services).toEqual(["privacy-service", "unsubscribe-service"]);

    // And the core one arrives through the barrel, not through a direct import by any module.
    const core = importersOf(keyFor("core")).map(moduleName);
    expect(core).toEqual(["index"]);
  });

  it("the FLOOR: no provisioning path, whatever any barrel does", () => {
    // The journal RUNNER and the production setup path are a different class from the rows above:
    // they do not merely belong to the server, they CHANGE it. No edge may ever convey them, so
    // this row has no size to pin and no expiry — it is zero now and stays zero.
    expect(list((p) => /packages\/db\/(src|dist)\/(migrate|setup-prod)\.(ts|js)$/.test(p))).toEqual([]);
  });
});

/**
 * ONE COPY OF EACH PACKAGE, UNLESS NAMED. `mailparser` 3.9.18 pinned newer MIME libraries than
 * `imapflow` 1.5.0, and the bundle carried both copies (+580 KB, two charset tables of ~390 KB):
 * nothing here reads a version. A package is identified by its LAST `node_modules/` segment and
 * versioned by its own manifest, so the reading does not depend on the package manager's layout.
 */
describe("the phone engine carries one copy of each package", () => {
  const packageOf = (input: string): { dir: string; name: string } | null => {
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) return null;
    const [head, next] = input.slice(at + 13).split("/");
    const name = head!.startsWith("@") ? `${head}/${next}` : head!;
    return { dir: `${input.slice(0, at + 13)}${name}`, name };
  };
  const manifest = (dir: string) =>
    JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf8")) as {
      version: string; dependencies?: Record<string, string>;
    };
  const copies = new Map<string, Set<string>>();
  for (const input of inputs) {
    const pkg = packageOf(input);
    if (pkg) copies.set(pkg.name, (copies.get(pkg.name) ?? new Set()).add(pkg.dir));
  }
  const semver = (v: string) => v.replace(/^[^\d]*/, "").split(/[.+-]/).slice(0, 3).map(Number);
  const below = (a: string, b: string) => {
    const [x, y] = [semver(a), semver(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) < (y[i] ?? 0);
    return false;
  };

  it("the MIME libraries both parsers pin: one copy each, at or above every importer's pin", () => {
    for (const name of ["libmime", "@zone-eu/mailsplit", "encoding-japanese"]) {
      const dirs = [...(copies.get(name) ?? [])];
      expect(dirs, `${name}: one copy`).toHaveLength(1);
      const carried = manifest(dirs[0]!).version;
      // Every package that imports it, and the version that package's manifest asks for.
      const pins: string[] = [];
      for (const [file, input] of Object.entries(meta.inputs)) {
        const from = packageOf(file);
        if (!from || from.name === name) continue;
        if (!(input.imports ?? []).some((i) => packageOf(i.path)?.name === name)) continue;
        const pin = manifest(from.dir).dependencies?.[name];
        if (pin) pins.push(`${from.name} ${pin}`);
      }
      expect(pins.length, `${name}: its importers were read`).toBeGreaterThan(0);
      expect(pins.filter((p) => below(carried, p.split(" ")[1]!)), `${name} ${carried} is below a pin`).toEqual([]);
    }
  });

  it("every package in more than one copy is named here, with its count", () => {
    // Pre-existing, each a major apart or a patched copy (`nodemailer` 6 carries a patch and sends;
    // 10.0.13 is mailparser's address parser). A count that FELL is lowered here; a package that
    // joins the list is a second copy nobody decided to ship. `libbase64` and `libqp` are a patch
    // apart (mailparser 3.9.32's MIME helpers against imapflow's). imapflow 1.7.8 carries no
    // nodemailer, so that count fell from 3 to 2. `readable-stream`, `safe-buffer` and
    // `string_decoder` fell to one copy when the zip archiver left the artifact (`jszip` in
    // `apps/sidecar/src/phone/aliases.js`).
    // Counted by installed DIRECTORY, which is what esbuild bundles: npm nests a copy wherever a range
    // cannot share the hoisted one, so a version can sit in two directories and ship twice.
    const named = {
      "dom-serializer": 2, domelementtype: 4, domhandler: 3, domutils: 2, entities: 3, htmlparser2: 2,
      libbase64: 3, libqp: 3, nodemailer: 2,
    };
    const measured = Object.fromEntries([...copies].filter(([, d]) => d.size > 1).map(([n, d]) => [n, d.size]).sort());
    expect(measured).toEqual(named);
    // 78 packages since the zip archiver and the CSS parser left; the floor is that the graph was read.
    expect(copies.size, "the census read the third-party graph").toBeGreaterThan(70);
  });
});

/**
 * THE ENGINE IS BUILT FROM SOURCE, WHETHER OR NOT THIS TREE WAS BUILT. The Android job bundles
 * straight after `npm ci`, with no `dist/` anywhere; CI and a contributor bundle after
 * `npm run build`. A workspace module reached through its built copy makes those two artifacts
 * differ, so the one measured is not the one that ships, and a module reached both ways ships its
 * code and tables twice (the shared-provider list once rode four times). Two readings: the graph
 * (fires in a tree that has `dist/`, which is where it can happen), and every workspace export
 * under the phone's own conditions (fires in any tree, built or not).
 */
describe("the phone engine reaches no workspace package's built copy", () => {
  it("no input of the graph is a workspace package's dist/", () => {
    expect(builtCopiesIn(meta)).toEqual([]);
  });

  it("REFUSES a planted built copy — the reading can fire", () => {
    const DIST = "packages/" + "core/dist/sender-check.js";
    expect(meta.inputs["packages/core/src/sender-check.ts"], "sender-check is in the graph").toBeDefined();
    expect(builtCopiesIn({ inputs: { ...meta.inputs, [DIST]: { bytes: 1 } } }))
      .toEqual([...builtCopiesIn(meta), DIST].sort());
  });

  it("no workspace export the phone's conditions select is a built copy", () => {
    const targets = workspaceExportTargets(REPO);
    // The vacuous-green guard: the census read the manifests and selected their source targets.
    expect(Object.keys(targets).length, "workspace exports read").toBeGreaterThan(60);
    expect(Object.values(targets).filter((t) => t?.startsWith("./src/")).length).toBeGreaterThan(60);
    expect(Object.entries(targets).filter(([, t]) => /^\.\/dist\//.test(t ?? "")).map(([s, t]) => `${s} -> ${t}`))
      .toEqual([]);
  });

  it("REFUSES an export whose phone condition names the built copy", () => {
    const planted = { ".": { types: "./src/index.ts", import: "./" + "dist/index.js", default: "./src/index.ts" } };
    expect(selectedExportTargets("@planted/pkg", planted)).toEqual({ "@planted/pkg": "./" + "dist/index.js" });
  });
});
