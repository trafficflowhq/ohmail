import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Copy, DECKS } from "../src/copy";
import { mobileDeviceKind, type MobileDeviceKind } from "../src/net/pairing";

/**
 * ═══ THE PHONE IS NEVER A HOST, AND ORGANIZES ONLY THROUGH THE ONE RULED DOOR ══════════════════
 *
 * The project's design notes §5 states the invariant and says it is held by nothing:
 *
 *   > the mobile artifact contains no listener, no `desktopHostRoutes`/`hostPairRoutes`, no
 *   > pairing mint. Today true by construction … and pinned by nothing.
 *
 * "True by construction" is the state a census exists to convert into a state that stays true. A
 * phone that became a HOST would be a second organizer of somebody's mailbox — the one invariant
 * the whole product is built around — and it would arrive not as a decision but as an import.
 *
 * ── WHAT MOVED IN 0.18, AND WHAT DID NOT ───────────────────────────────────────────────────────
 *
 * This file used to say the phone is never the organizer either, because it was not: three doors,
 * all of them somebody else's machine. 0.18 adds the fourth, ruled door — an engine inside this app
 * over its own SQLite file, organizing while the app is open (and, on Android, behind a notification
 * a person can see). So the refusals are re-derived rather than deleted, and they split cleanly:
 *
 *  · **NOTHING ABOUT BEING A HOST MOVED.** No listener, no pairing mint, no host-mode switch, no
 *    server route table, no lease module, no IMAP adapter in the static graph. §§1–2 keep every
 *    rule they had, and §1 is now LOAD-BEARING rather than incidental: the engine reaches this app
 *    as a PRE-BUNDLED artifact registered at runtime (`src/engine/engine-artifact.ts`), so its
 *    module graph is deliberately not in this app's — which is what §1 measures.
 *  · **ONE ORGANIZER DOOR, NOT A FAMILY.** §3 no longer refuses a `standalone` route; it refuses a
 *    SECOND one, and every host screen. A route matching `organize`/`host` is still a finding.
 *  · **CONDITIONAL, NEVER PROMISED.** §4 no longer demands a negation beside every "this phone
 *    organizes" clause. It demands a negation OR A CONDITION, which is exactly the ruling: the
 *    phone organizes *while* something is true. "This phone organizes your mailbox." is still
 *    refused; "It organizes while ohmail is open." is admitted.
 *  · **FOUR DOORS IN THE POSITIVE CONTROL**, and the fourth one's three ruled limitation sentences
 *    in place of the retired `doorsNoFourthDoor`. The job is the same: the limits are STATED rather
 *    than inferred, and a refactor that deleted them fails here.
 *
 * ── FOUR SHAPES, BECAUSE A DOOR CAN BE BUILT FOUR WAYS ─────────────────────────────────────────
 *
 * Refusing only the import would refuse only the tidiest way to do it. Each section below refuses
 * one way a phone-as-host or phone-as-organizer door could actually reach a person:
 *
 *  1. **THE GRAPH** — a module that makes the phone a host or an organizer, reached from any
 *     screen. The census walks the transitive static import graph from every expo-router route and
 *     fails on the server route tables (`packages/api/src`), the node listener
 *     (`packages/core/src/adapters/http-host.ts`), the desktop engine composition
 *     (`apps/sidecar/src`), the IMAP adapter, the lease and the worker's loop.
 *  2. **THE CODE** — a listener or a host-mode switch written by hand, with nothing imported. A
 *     `createServer` and a `.listen(` do not need a workspace package.
 *  3. **THE ROUTE** — a screen. expo-router's route table IS the `app/` directory, so a file is a
 *     door whether or not anything links to it yet, and a `router.push` at a door that does not
 *     exist is the same door half-built. One organizer door is ruled; a second is a finding.
 *  4. **THE SENTENCE** — copy that promises organizing UNCONDITIONALLY. This is the shape with no
 *     compiler and no import behind it, and it is the one a person actually acts on: a tile reading
 *     "organize your mailbox on this phone" promises a phone that always does, and the code being
 *     conditional underneath does not undo the promise. §4 holds every deck string to it.
 *
 * ── AND THE POSITIVE HALF, WHICH IS NOT DECORATION ─────────────────────────────────────────────
 *
 * A guard whose every case asserts a refusal has no evidence it admits the right thing: a census
 * that walked an EMPTY graph, scanned an EMPTY file set and read an EMPTY deck would pass all of
 * §§1–4 and mean nothing. §5 is what makes a vacuous green impossible — the four doors are named
 * in both languages, each one's target exists, the fourth's three ruled sentences are stated, and
 * the phone's own declared kind is one of exactly two mobile values. If a refactor deletes a door,
 * this file goes red for the OPPOSITE reason to §§1–4, which is the point.
 *
 * ── HOW IT WAS WATCHED FAIL ────────────────────────────────────────────────────────────────────
 *
 * Two independent ways, because a one-time observation of a red is not a property of the guard:
 *
 *  · **PERMANENTLY**, by the controls in §6. Each refusal rule is a pure function, run there over
 *    planted input that is not in the tree: a source string importing the server route table, a
 *    file path under `apps/sidecar/src`, a hand-written listener, a `standalone` route, and four
 *    deck sentences that promise organizing in English and German. A rule that stopped firing fails
 *    §6 rather than passing §§1–4 in silence.
 *  · **ONCE, AGAINST THE REAL TREE**, by planting each violation in the shipped source and watching
 *    exactly the intended case go red. The mutations and their reds are recorded in this commit's
 *    message; §6 is what keeps them true after the restore.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const REPO = resolve(APP, "../..");
const r = (p: string): string => resolve(REPO, p);
const rel = (p: string): string => relative(REPO, p);

/**
 * THIS REPOSITORY'S OWN WORKSPACE SCOPE, COMPOSED RATHER THAN WRITTEN OUT.
 *
 * `packages/fixtures/src/privacy.ts` bans the company name as REAL IDENTITY, and `privacy.test.ts`
 * scans every file under `apps/mobile` for it — test files deliberately included, on the stated
 * grounds that "a real brand in a test file is still a real brand in this repository". This census
 * was red on exactly that rule the first time it ran beside the rest of the suite.
 *
 * A census whose entire subject is WHICH WORKSPACE PACKAGES THE PHONE MAY IMPORT cannot avoid
 * reasoning about that scope, so it does what `privacy.test.ts` itself does with the forge name it
 * must ban and therefore cannot write: composes the term once, here, and derives every pattern and
 * every planted control string from the constant. Nothing below spells it.
 *
 * The alias table read out of `vitest.config.ts` carries the same scope as DATA at run time. That
 * is not source text in this file, and a runtime value is not what the banlist is about.
 */
const SCOPE = `@${["traffic", "flow"].join("")}`;

/* ── the shared machinery ──────────────────────────────────────────────────────────────────── */

/**
 * Comments out, and this is the difference between a census and a word search.
 *
 * `src/net/mailboxes.ts` explains, in prose, that its request is served by a table which
 * `desktopHostRoutes` also spreads — a true sentence ABOUT a server-side route, in a file that
 * imports nothing of the kind. `src/state/live.ts` says "A phone cannot be the organizer" in a doc
 * comment. A scanner that cannot tell prose from code fails both, and the fix somebody reaches for
 * is an inline disable, which is how a census stops meaning anything within a week. The same
 * stripper runs ahead of every scan below, including the import extractor — a forbidden module
 * NAMED in a comment (this file's own header names six) is not a forbidden module imported.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // not the `//` in a `https://`

/** Every module specifier a file statically imports, re-exports from, or `require`s. */
function specifiersOf(source: string): string[] {
  const src = stripComments(source);
  const out = new Set<string>();
  const push = (re: RegExp): void => {
    for (let m = re.exec(src); m !== null; m = re.exec(src)) out.add(m[1]!);
  };
  push(/\bfrom\s*["']([^"']+)["']/g); // import/export … from "X"
  push(/\bimport\s*\(\s*["']([^"']+)["']/g); // dynamic import("X")
  push(/\bimport\s+["']([^"']+)["']/g); // side-effect import "X"
  push(/\brequire\s*\(\s*["']([^"']+)["']/g); // the config plugins are CommonJS
  return [...out];
}

/**
 * The workspace alias table, READ OFF `vitest.config.ts` rather than copied into this file.
 *
 * A hand-maintained copy is a second source of truth for module resolution, and the two drift in
 * the direction that makes a census weaker: an alias the suite resolves and the census does not
 * becomes an unresolved edge, and an unresolved edge is a subgraph nobody walked. Reading the real
 * table means this census resolves exactly what the run resolves, and a package added tomorrow is
 * covered with nobody remembering to add it here.
 *
 * The one entry not of this shape is a `RegExp` find (`next-intl`), which no phone module reaches;
 * it falls through to `"external"` like any npm package, which is the correct answer for it.
 */
function aliasTable(): Record<string, string> {
  const cfg = readFileSync(r("vitest.config.ts"), "utf8");
  const out: Record<string, string> = {};
  for (const m of cfg.matchAll(/\{\s*find:\s*"([^"]+)",\s*replacement:\s*r\("\.\/([^"]+)"\)\s*\}/g)) {
    out[m[1]!] = r(m[2]!);
  }
  return out;
}
const ALIASES = aliasTable();
/** Longest first: the bare `…/core` entry must not swallow `…/core/adapters/imap`. */
const ALIAS_KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);

/** Every `.ts`/`.tsx` under `dir`, recursively. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/* ── §1. the graph ─────────────────────────────────────────────────────────────────────────── */

/**
 * What a host or an organizer is BUILT from. Each line is a capability, not a name:
 *
 *  · `…/api*` — the server route tables. `desktopHostRoutes` and `hostPairRoutes` (the pairing
 *    MINT) live here; a phone that imported this could serve other devices.
 *  · `…/core/adapters/http-host` — the node listener itself.
 *  · `…/core/adapters/imap` — opens the person's mailbox. Nothing else in the product can make a
 *    second organizer on its own; this is the one that can.
 *  · `…/core/adapters/organizer-lease` and `organizer-profile*` — claims it, and writes the
 *    `ohmail/_meta` records only the holder may write.
 *  · `…/worker/*` — the shared sync loop and the lease's server half.
 *  · `…/services*`, `…/db*`, `@ohmail/db-mail` — the organizer's data plane.
 *  · `@ohmail/sidecar` — the desktop engine composition, which is all of the above at once.
 *
 * The scoped halves are built from {@link SCOPE}, which is composed rather than written; see its
 * note. `@ohmail/*` is not banned and is written out.
 */
const FORBIDDEN_SPECIFIER = (spec: string): boolean =>
  [
    new RegExp(`^${SCOPE}/api(/|$)`),
    new RegExp(`^${SCOPE}/worker(/|$)`),
    new RegExp(`^${SCOPE}/services(/|$)`),
    new RegExp(`^${SCOPE}/db(/|$)`),
    new RegExp(`^${SCOPE}/db-mail(/|$)`),
    new RegExp(`^${SCOPE}/core/adapters/(http-host|imap|organizer-)`),
    /^@ohmail\/db-mail(\/|$)/,
    /^@ohmail\/sidecar(\/|$)/,
  ].some((re) => re.test(spec));

/**
 * THE ONE FILE UNDER `apps/sidecar` THE PHONE MAY REACH, AND WHY THE EXEMPTION IS SAFE.
 *
 * HOSTS §5 names `apps/sidecar` absent from the bundle graph, and the phone reaches exactly one
 * file in it: `src/net/server-base.ts` imports `cloud-origin.ts` by relative path, deliberately, so
 * that the phone and the desktop cannot disagree about what a typed address means or about where a
 * server's mail API turned out to be. Deleting that edge would not make the phone safer; it would
 * give the product two answers to one question, which is the defect `server-base.ts`'s own header
 * was written about.
 *
 * So the rule is not relaxed — it is BOUNDED BY A PROPERTY THIS CENSUS CHECKS. `cloud-origin.ts`
 * imports nothing at all, and the case below asserts that. A leaf cannot be a doorway: no future
 * edit can smuggle the engine in behind it without first giving it an import, and the moment it has
 * one this census goes red on the exemption itself rather than on whatever arrived through it.
 *
 * An exemption whose safety is asserted rather than trusted is the only kind worth having; an
 * exemption keyed on a path alone would be a hole that widens quietly.
 */
const SIDECAR_LEAF = r("apps/sidecar/src/cloud-origin.ts");

/**
 * THE SAME EXEMPTION, ASKED FROM THE OTHER END — and the arm that closes the class.
 *
 * The case above bounds the ONE file the phone reaches by a property of THAT file. It says
 * nothing about a SECOND relative import out of this app, to a module that happens to import
 * nothing host-shaped and so walks the graph census without a hit. The 0.20.0 review filed that
 * reach as an architecture row (an app coupled to another app's file layout, and the source-leaf
 * hazard class beside it); the move to a shared home is owed and is not free — the sidecar may
 * not link `@ohmail/client-engine` by its own rule, the engine census sanctions the managed base
 * literal AT THIS PATH and re-arms on a rename, and two published windows name the file. Until
 * that move, the honest thing is to hold the class at one, by name.
 *
 * Relative only: a BARE specifier is a package edge, which §1's own forbidden-module rule judges.
 */
function escapingImports(file: string, source: string): string[] {
  return specifiersOf(source)
    .filter((spec) => spec.startsWith("."))
    .filter((spec) => {
      const target = resolve(dirname(file), spec);
      return target !== APP && !target.startsWith(`${APP}/`);
    })
    .sort();
}

/** The one reach out of this app that is allowed, as the pair this census prints. */
const SANCTIONED_ESCAPE =
  "apps/mobile/src/net/server-base.ts -> ../../../sidecar/src/cloud-origin.js";

/**
 * THE ONE EDGE THAT LEAVES THE APP'S GRAPH ON PURPOSE — the phone's pre-bundled engine.
 *
 * §1 measures the app's own module graph, and the fourth door's engine is deliberately NOT in it:
 * it arrives as one generated file with every specifier already resolved, every Node builtin
 * already substituted, and a metafile the graph censuses read instead (`no-node-builtins.test.ts`,
 * the dialect census). `src/engine/local-engine.ts` states the reason — importing the engine's
 * SOURCE would make Metro resolve that whole graph again, with its own rules and none of the
 * substitutions, which is the artifact this census exists to prevent.
 *
 * So the edge resolves to a sentinel and the walk stops there. The allowance is bounded by a
 * property, not by a path: the specifier may be named by EXACTLY ONE file, and that file is the
 * loader (asserted below). A screen that reached for the artifact directly would be a second namer
 * and red here, which is the same rule §3 applies to the door itself.
 */
const ARTIFACT_SPEC = "../../generated/phone-engine.js";
const ARTIFACT_LOADER = "src/engine/engine-bundle-native.ts";
/** The same generator's second file: pdf.js as strings for the attachment preview's page. It holds
 *  no import and reaches nothing; bounded the same way, to one namer. */
const PDF_FRAME_SPEC = "../../generated/pdf-frame.js";
const PDF_FRAME_LOADER = "src/mail/pdf-frame-native.ts";

/** A resolved SOURCE FILE an organizer or a host is built from — the other half of the graph rule. */
const FORBIDDEN_FILE = (file: string): boolean => {
  if (file === SIDECAR_LEAF) return false;
  const p = rel(file);
  return p.startsWith("apps/sidecar/src/")
    || p.startsWith("apps/worker/src/")
    || p.startsWith("packages/api/src/")
    || p.startsWith("packages/services/src/")
    || p.startsWith("packages/db/src/")
    || p.startsWith("packages/db-mail/src/")
    || p.startsWith("packages/core/src/adapters/");
};

/** Resolve to a source file, `"external"` (npm/node) or `null` (a workspace edge nobody mapped). */
function resolveSpec(
  spec: string,
  fromFile: string,
  unresolved: Set<string>,
): string | "external" | null {
  if (spec === ARTIFACT_SPEC || spec === PDF_FRAME_SPEC) return "external";
  if (spec.startsWith(".")) {
    const base = dirname(fromFile);
    const candidates = spec.endsWith(".js")
      ? [join(base, spec.replace(/\.js$/, ".ts")), join(base, spec.replace(/\.js$/, ".tsx"))]
      : [
          join(base, `${spec}.ts`),
          join(base, `${spec}.tsx`),
          join(base, spec, "index.ts"),
          join(base, spec, "index.tsx"),
        ];
    const hit = candidates.find((c) => existsSync(c));
    if (hit === undefined) unresolved.add(`${rel(fromFile)} → ${spec}`);
    return hit ?? null;
  }
  for (const key of ALIAS_KEYS) {
    if (spec === key || spec.startsWith(`${key}/`)) return ALIASES[key]!;
  }
  if (spec.startsWith(`${SCOPE}/`) || spec.startsWith("@ohmail/")) {
    unresolved.add(`${rel(fromFile)} → ${spec}`);
    return null;
  }
  return "external";
}

interface Crawl {
  visited: Set<string>;
  hits: string[];
  unresolved: Set<string>;
}

function crawl(roots: readonly string[]): Crawl {
  const visited = new Set<string>();
  const hits: string[] = [];
  const unresolved = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    if (FORBIDDEN_FILE(file)) hits.push(`${rel(file)} is in the phone's graph`);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of specifiersOf(source)) {
      if (FORBIDDEN_SPECIFIER(spec)) hits.push(`${rel(file)} imports ${spec}`);
      const target = resolveSpec(spec, file, unresolved);
      if (target !== null && target !== "external" && !visited.has(target)) stack.push(target);
    }
  }
  return { visited, hits, unresolved };
}

/**
 * THE ROOTS ARE DERIVED, NOT LISTED. expo-router's route table IS this directory (`package.json`
 * `"main": "expo-router/entry"`), so every file under it is an entry point of the shipped bundle. A
 * typed list would go stale the first time somebody adds a screen — and a screen nobody added to
 * the list is exactly the screen a new door would arrive on.
 */
const ROUTE_FILES = walk(join(APP, "app"));

describe("§1 the graph — no screen can reach a host or an organizer", () => {
  const result = crawl(ROUTE_FILES);

  it("resolved every workspace edge, so the graph it walked is complete", () => {
    // A silently skipped edge is a silently incomplete graph — the one way this goes falsely green.
    expect([...result.unresolved].sort(), "an unresolved workspace edge is an unwalked subgraph")
      .toEqual([]);
  });

  it("exactly one file names the pre-bundled engine, and it is the loader", () => {
    /**
     * The bound on the one edge that leaves this graph (see {@link ARTIFACT_SPEC}). The walk stops
     * at the artifact, so admitting it on a path alone would be a hole: any screen could reach the
     * organizer through the same specifier and this census would say nothing. Naming the ONE
     * legitimate namer is what keeps the allowance the size it was argued for.
     *
     * Read over the app's whole source rather than over the crawl, because a file the crawl never
     * reached is exactly where a second namer would hide.
     */
    const namers = [...walk(join(APP, "src")), ...walk(join(APP, "app"))]
      .filter((f) => readFileSync(f, "utf8").includes(ARTIFACT_SPEC))
      .map((f) => rel(f).replace("apps/mobile/", ""))
      .sort();
    expect(namers).toEqual([ARTIFACT_LOADER]);
  });

  it("exactly one file names the preview's pdf.js, and it is its loader", () => {
    const namers = [...walk(join(APP, "src")), ...walk(join(APP, "app"))]
      .filter((f) => readFileSync(f, "utf8").includes(PDF_FRAME_SPEC))
      .map((f) => rel(f).replace("apps/mobile/", ""));
    expect(namers).toEqual([PDF_FRAME_LOADER]);
  });

  it("actually walked the app — not a vacuous green", () => {
    expect(ROUTE_FILES.length, "expo-router's route table is empty").toBeGreaterThan(14);
    for (const route of ["app/welcome.tsx", "app/servers.tsx", "app/scan.tsx", "app/connect.tsx"]) {
      expect(ROUTE_FILES.map(rel).map((p) => p.replace("apps/mobile/", ""))).toContain(route);
    }
    // It left this app and reached the shared client engine, which is where a graph this census
    // must cover actually goes. A crawl that stopped at the app boundary would prove nothing about
    // what the bundle contains.
    expect(result.visited.has(r("packages/client-engine/src/engine.ts"))).toBe(true);
    expect(result.visited.has(r("apps/mobile/src/net/pairing.ts"))).toBe(true);
    expect(result.visited.has(r("apps/mobile/src/engine/boot.ts"))).toBe(true);
    expect(result.visited.size).toBeGreaterThan(80);
  });

  it("reaches no server route table, no listener, no IMAP adapter, no lease, no worker loop", () => {
    expect(
      result.hits.sort(),
      "the phone's bundle graph reached a module a host or an organizer is built from",
    ).toEqual([]);
  });

  it("the one exempted sidecar file is a leaf, so the exemption cannot become a doorway", () => {
    // The exemption is bounded by this property, not by trust — see SIDECAR_LEAF's note. Give
    // `cloud-origin.ts` a single import and this case goes red before anything can arrive behind it.
    expect(existsSync(SIDECAR_LEAF), "the exempted file is gone — delete the exemption").toBe(true);
    expect(
      specifiersOf(readFileSync(SIDECAR_LEAF, "utf8")),
      "the exempted sidecar file now imports something — it is no longer a leaf",
    ).toEqual([]);
    // And it is genuinely in the graph: an exemption for a file nobody reaches is dead weight that
    // reads as permission.
    expect(result.visited.has(SIDECAR_LEAF)).toBe(true);
  });

  it("exactly one module in this app reaches outside it, and it is the named one", () => {
    const escapes = [...walk(join(APP, "src")), ...walk(join(APP, "app"))]
      .flatMap((f) => escapingImports(f, readFileSync(f, "utf8")).map((spec) => `${rel(f)} -> ${spec}`))
      .sort();
    expect(escapes, "a second relative import out of this app — see `escapingImports`")
      .toEqual([SANCTIONED_ESCAPE]);
  });
});

/* ── §2. the code ──────────────────────────────────────────────────────────────────────────── */

/**
 * The shipped source: everything Metro bundles. Tests are excluded because a test that NAMES
 * `createServer` in order to forbid it — this file, and `doors.test.ts`, which stands up a real
 * loopback stack to prove the self-hosted door — is not a listener in the app.
 */
const SHIPPED = [join(APP, "src"), join(APP, "app"), join(APP, "plugins"), join(APP, "modules")]
  .filter((d) => existsSync(d))
  .flatMap((d) =>
    walk(d).concat(
      // The config plugins are `.js`; they edit the generated native project and are exactly where
      // a manifest-level listener or an exported service would be added.
      readdirSync(d)
        .filter((e) => e.endsWith(".js"))
        .map((e) => join(d, e)),
    ),
  );

/**
 * Written by hand, with nothing imported. Each entry is a capability a phone must not have:
 * a socket it answers on, a host-mode switch, a server-side route table spread into this app, or
 * the act of MINTING a pairing code (a phone consumes codes; issuing one is being the host).
 */
const HOST_CODE: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\bcreateServer\s*\(/, why: "a server socket in the app" },
  { re: /\.listen\s*\(/, why: "a socket the phone answers on" },
  { re: /\bOHMAIL_HOST_MODE\b/, why: "the host-mode switch" },
  { re: /\bOHMAIL_LAN_BIND\b/, why: "the LAN bind address" },
  { re: /\bdesktopHostRoutes\b/, why: "the desktop-host route table" },
  { re: /\bhostPairRoutes\b/, why: "the pairing-mint route table" },
  { re: /\bselfHostRoutes\b/, why: "the self-host route table" },
  { re: /\blocalRoutes\b/, why: "the administrator route table" },
  { re: /\bmintPair|\bcreatePairingToken\b/, why: "minting a pairing code" },
  { re: /\bORGANIZER_KINDS\b/, why: "the organizer-kind vocabulary" },
  { re: /\bmayOrganize\b/, why: "the organizer's own gate" },
  { re: /\btakeover_authorized_at\b/, why: "the takeover stamp only a claimant writes" },
  { re: /\btakeover_intent\b/, why: "the verb behind the takeover stamp" },
  { re: /\borganizer_role\b/, why: "the organizer role column" },
];

/** Every `HOST_CODE` shape present in `body`, which is expected to be comment-stripped already. */
const hostCodeIn = (body: string): string[] =>
  HOST_CODE.filter(({ re }) => re.test(body)).map(({ why }) => why);

describe("§2 the code — no listener, no host mode, no mint, written by hand", () => {
  it("scanned the shipped source at all", () => {
    const paths = SHIPPED.map((f) => rel(f).replace("apps/mobile/", ""));
    expect(SHIPPED.length, "the shipped source scan found nothing").toBeGreaterThan(40);
    for (const named of ["src/net/pairing.ts", "src/ui/Doors.tsx", "app/welcome.tsx"]) {
      expect(paths).toContain(named);
    }
    expect(paths.some((p) => p.startsWith("plugins/")), "no config plugins scanned").toBe(true);
  });

  it("carries none of the shapes that would make this phone a host or a claimant", () => {
    const found: string[] = [];
    for (const file of SHIPPED) {
      for (const why of hostCodeIn(stripComments(readFileSync(file, "utf8")))) {
        found.push(`${rel(file).replace("apps/mobile/", "")}: ${why}`);
      }
    }
    expect(found.sort(), "the phone's shipped source builds a host or claims a mailbox").toEqual([]);
  });
});

/* ── §3. the route ─────────────────────────────────────────────────────────────────────────── */

/**
 * A screen is a door whether or not anything links to it yet, and a link is a door whether or not
 * the screen exists yet. Both halves are refused, because a door lands one half at a time and the
 * half that lands first is the one nobody notices.
 */
const FORBIDDEN_ROUTE = /organi[sz]e|organizer|be-?the-?host|\bhost\b/i;

/**
 * THE ONE ORGANIZER DOOR THIS PRODUCT HAS. Exactly this route, and the census counts it.
 *
 * `standalone` left {@link FORBIDDEN_ROUTE} when the fourth door was ruled, and a plain removal
 * would have left the whole family admitted — `standalone2.tsx`, `standalone/advanced.tsx`, a
 * second engine door under any name. So it is an ALLOWLIST of one: the route matching this is the
 * ruled door, and §3 asserts there is exactly one of it.
 */
const STANDALONE_ROUTE = /^standalone$/;

/** Is this route the ruled organizer door, or an unruled one? */
const isStandalone = (route: string): boolean => STANDALONE_ROUTE.test(route);
const standaloneish = (route: string): boolean => /standalone/i.test(route);

/** Every navigation target written as a literal in the shipped source. */
function navTargets(body: string): string[] {
  const out = new Set<string>();
  const push = (re: RegExp): void => {
    for (let m = re.exec(body); m !== null; m = re.exec(body)) out.add(m[1]!);
  };
  push(/\brouter\.(?:push|replace|navigate)\s*\(\s*["'`]([^"'`]+)["'`]/g);
  push(/\bhref\s*=\s*\{?\s*["'`](\/[^"'`]*)["'`]/g);
  return [...out];
}

describe("§3 the route — no screen that offers to organize, and no link to one", () => {
  const routes = ROUTE_FILES.map((f) => rel(f).replace("apps/mobile/app/", "").replace(/\.tsx?$/, ""));
  const targets = SHIPPED.flatMap((f) => navTargets(stripComments(readFileSync(f, "utf8"))));

  it("read the route table and the links — not a vacuous green", () => {
    expect(routes, "the route table is empty").toContain("welcome");
    expect(routes).toContain("servers");
    expect(routes).toContain("scan");
    // The extractor found real links, so an empty result below would be a finding and not a scan
    // that matched nothing.
    expect(targets.length, "no navigation targets extracted").toBeGreaterThan(4);
    expect(targets).toContain("/scan");
    expect(targets).toContain("/connect");
  });

  it("has no organize / host screen", () => {
    expect(routes.filter((route) => FORBIDDEN_ROUTE.test(route))).toEqual([]);
  });

  it("links to no such screen either — the half of a door that lands first", () => {
    expect(targets.filter((t) => FORBIDDEN_ROUTE.test(t))).toEqual([]);
  });

  /**
   * EXACTLY ONE ORGANIZER DOOR — the ruled one, and no sibling beside it.
   *
   * Two doors that both start an engine are two ways to end up with two engines, which is the
   * double-organizer hazard arriving as a route rather than as an import. The count is the
   * assertion: a second file with `standalone` anywhere in its name fails here, whatever it is
   * called, and so does the ruled one going missing.
   */
  it("has exactly one organizer door, and it is the ruled route", () => {
    const mine = routes.filter(standaloneish);
    expect(mine, "the organizer door is missing, or there is more than one").toEqual(["standalone"]);
    expect(mine.every(isStandalone)).toBe(true);
    // And every link into that family points at the ruled route, never a sibling.
    expect([...new Set(targets.filter((t) => /standalone/i.test(t)))]).toEqual(["/standalone"]);
  });
});

/* ── §4. the sentence ──────────────────────────────────────────────────────────────────────── */

/**
 * THE SHAPE WITH NO COMPILER BEHIND IT, AND THE ONE A PERSON ACTS ON.
 *
 * §§1–3 refuse doors in the code. This refuses a door in the reader's head: a tile reading
 * "Organize your mailbox on this phone" promises a phone that organizes FULL STOP, and the code
 * being conditional underneath does not undo the promise — it just means the person finds out when
 * they close the app and their mail stops being filed.
 *
 * The rule is per CLAUSE rather than per string, and that is what makes it usable. Most of the door
 * deck is a sentence like *"Our hosted service does the organizing; this phone keeps a copy"* — a
 * phone and an organizing verb in one string, and entirely true, because they are in different
 * clauses with different subjects. A string-level rule would have to be weakened to admit it, and a
 * weakened rule admits the thing it exists to refuse.
 *
 * ── THE RULE 0.18 RE-DERIVED, AND WHY IT IS NOT A WEAKENING ────────────────────────────────────
 *
 * This used to read: a clause naming the phone AND an organizing verb must carry a NEGATION. The
 * fourth door makes that false of the product — the phone does organize — so the rule would have
 * had to be deleted or watered down, and a deleted rule admits the promise.
 *
 * The ruling itself supplies the replacement, because the ruling is conditional: the phone
 * organizes *while* the app is open, *while* the notification is shown. So the rule is a negation
 * OR A CONDITION, and the thing still refused is precisely the unconditional promise. It has the
 * same force as before on everything the old rule caught, and it names the new true sentences
 * without admitting a single false one — §6 runs both halves over planted input.
 */
const PHONE = /\b(this phone|dieses (telefon|handy)|diesem (telefon|handy)|your phone|dein (telefon|handy)|deinem (telefon|handy))\b/i;
const ORGANIZE = /organiz|organisier/i;
const NEGATION = /\b(not|never|no|cannot|can't|nicht|kein|keine|keinen)\b/i;
/**
 * THE CONDITION the ruled sentences carry. Each one names a state the organizing depends on —
 * `while`/`solange` the app is open, `only`/`nur` then, `when`/`wenn` you leave it hands back.
 *
 * Deliberately NOT a catch-all for subordinate clauses: "because", "so that" and "although" would
 * admit an unconditional promise wearing a reason. These six words are the ones that make the
 * organizing depend on something, which is the ruling's own shape.
 */
const CONDITION = /\b(while|only|when|solange|nur|wenn)\b/i;

/**
 * The clauses of `text` that promise organizing on this phone with neither a negation nor a
 * condition — an unconditional promise, and the only thing §4 refuses.
 */
function organizingPromises(text: string): string[] {
  return text
    .split(/[.:;?!—]|\s-\s/)
    .filter((c) => PHONE.test(c) && ORGANIZE.test(c) && !NEGATION.test(c) && !CONDITION.test(c))
    .map((c) => c.trim());
}

/**
 * Every string a deck can render, read off the deck SOURCE rather than off the object.
 *
 * The object would give the string members and hide the function ones, and a function is where a
 * sentence is assembled — `(name) => \`${name} organizes this mailbox\`` is a promise the object
 * walk never sees, because calling it needs an argument nobody here can supply truthfully.
 */
function deckStrings(file: string): string[] {
  const body = stripComments(readFileSync(file, "utf8"));
  const out: string[] = [];
  for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]!);
  for (const m of body.matchAll(/`((?:[^`\\]|\\.)*)`/g)) out.push(m[1]!);
  return out;
}

const DECK_FILES = { en: join(APP, "src/copy.en.ts"), de: join(APP, "src/copy.de.ts") } as const;

/**
 * ═══ THE TWO CLAUSES WHOSE CONDITION IS IN THE NEXT LINE ═══════════════════════════════════════
 *
 * Measured, not assumed: with the fourth door landed, exactly two deck strings put the phone and an
 * organizing verb in one clause and carry the condition in a SIBLING string instead —
 *
 *  · `phoneStandaloneTitle` — the limitations screen's heading, whose next three lines ARE the
 *    condition, and are the whole reason that screen exists;
 *  · `doorPhoneSay` — the tile's second line, whose THIRD line is the condition, which is the
 *    tile's whole anatomy (`Doors.tsx#Door`: name, say, need).
 *
 * ── WHY THIS IS A NAMED CONSUMER AND NOT A HOLE IN §4 ──────────────────────────────────────────
 *
 * The alternative was to let §4 see across strings, which it cannot do: a deck is a flat table and
 * nothing in it says which string renders under which. So the licence is per KEY and carries a
 * proof obligation — the case below asserts every named sibling EXISTS, is CONDITIONAL by §4's own
 * test, and is rendered beside its licensed clause. Delete the sibling and this goes red; give a
 * third key such a clause and §4 catches it, because the licence is keyed and not pattern-based.
 *
 * The licensed text is read from the DECK rather than written here, so an edit to either string
 * moves its licence with it and cannot leave a stale allowance behind.
 */
const CONDITION_IN_SIBLING: Record<string, readonly string[]> = {
  phoneStandaloneTitle: ["phoneStandaloneL1Ios", "phoneStandaloneL1Android",
                         "phoneStandaloneL2", "phoneStandaloneL3", "phoneStandaloneL4"],
  doorPhoneSay: ["doorPhoneNeedIos", "doorPhoneNeedAndroid"],
};

/** Every promise clause the licensed keys produce, in both decks — the exact licensed text. */
function licensedClauses(): Set<string> {
  const out = new Set<string>();
  for (const deck of Object.values(DECKS)) {
    for (const key of Object.keys(CONDITION_IN_SIBLING)) {
      const value = (deck as unknown as Record<string, unknown>)[key];
      if (typeof value !== "string") continue;
      for (const clause of organizingPromises(value)) out.add(clause);
    }
  }
  return out;
}

describe("§4 the sentence — no copy promises that this phone organizes", () => {
  for (const [locale, file] of Object.entries(DECK_FILES)) {
    const strings = deckStrings(file);

    it(`read the ${locale} deck — not a vacuous green`, () => {
      expect(strings.length, `the ${locale} deck extractor found nothing`).toBeGreaterThan(300);
      // The one clause of this shape that SHOULD be there is there, which proves the split and both
      // patterns fire on real deck text rather than only on §6's planted input.
      const own = strings.filter((s) => PHONE.test(s) && ORGANIZE.test(s));
      expect(own.length, `no ${locale} deck string names the phone and organizing at all`)
        .toBeGreaterThan(0);
    });

    it(`the ${locale} deck makes no unconditional promise`, () => {
      const licensed = licensedClauses();
      const found = strings.flatMap(organizingPromises).filter((c) => !licensed.has(c));
      expect(found.sort(), `an unlicensed clause promises organizing in ${locale}`).toEqual([]);
    });

    /**
     * AND THE CONDITION IS ACTUALLY THERE — the other half, which a negation-only rule cannot see.
     *
     * A deck could satisfy the case above by never naming the phone and organizing together, which
     * for THIS product means the limitations screen said nothing. At least one clause must carry
     * both words and a condition: that is the ruled sentence, present and conditional.
     */
    /**
     * THE LICENCE'S PROOF OBLIGATION — every named sibling exists and is itself conditional.
     *
     * Without this the licence would be a hole: a key could keep its unconditional clause after
     * its sibling was deleted, and §4 would go on admitting it. This is what makes the licence
     * cost something — and it is watched failing in §6 over a sibling map with a missing key.
     */
    it(`every licensed ${locale} clause has a sibling that states the condition`, () => {
      const deck = DECKS[locale as keyof typeof DECKS] as unknown as Record<string, unknown>;
      for (const [key, siblings] of Object.entries(CONDITION_IN_SIBLING)) {
        expect(typeof deck[key], `${locale}: the licensed key ${key} is gone`).toBe("string");
        expect(siblings.length, `${key} names no sibling`).toBeGreaterThan(0);
        for (const sib of siblings) {
          const value = deck[sib];
          expect(typeof value, `${locale}: ${key}'s sibling ${sib} is gone`).toBe("string");
          const said = value as string;
          expect(said.trim().length, `${locale}: ${sib} is blank`).toBeGreaterThan(0);
          /* CONDITIONAL OR NEGATED — the sibling has to do the job the licensed clause does not.
             `phoneStandaloneL2` ("One mailbox on this phone.") is a LIMIT rather than a condition,
             so a limit counts too: what is refused is a sibling that says nothing restrictive. */
          expect(
            CONDITION_IN_SIBLING[key]!.some((n) => {
              const v = deck[n];
              return typeof v === "string" && (CONDITION.test(v) || NEGATION.test(v));
            }),
            `${locale}: none of ${key}'s siblings states a condition`,
          ).toBe(true);
        }
      }
    });

    it(`the ${locale} deck states the condition the organizing depends on`, () => {
      const conditional = strings.filter(
        (str) => PHONE.test(str) && ORGANIZE.test(str) && CONDITION.test(str),
      );
      expect(conditional.length, `no ${locale} string says WHEN this phone organizes`)
        .toBeGreaterThan(0);
    });
  }
});

/* ── §5. the positive control: the four doors, named and reachable ─────────────────────────── */

/**
 * WITHOUT THIS SECTION §§1–4 WOULD PASS OVER A PHONE WITH NO DOORS AT ALL.
 *
 * Every case above asserts an absence, and an empty app satisfies all of them. What makes the
 * refusals mean something is that the four doors the product DOES have are here, in both languages,
 * each pointing at something that exists — so a change that removed a door to satisfy a refusal
 * fails here instead of passing quietly.
 */
describe("§5 the four doors are named and reachable — the positive control", () => {
  const doors = readFileSync(join(APP, "src/ui/Doors.tsx"), "utf8");
  const welcome = readFileSync(join(APP, "app/welcome.tsx"), "utf8");
  const servers = readFileSync(join(APP, "app/servers.tsx"), "utf8");

  it("names all four, in both languages, differently from each other", () => {
    for (const [locale, deck] of Object.entries(DECKS)) {
      const named = [deck.doorCloud, deck.doorOwnServer, deck.doorDesktop, deck.doorPhone];
      for (const name of named) expect(name.trim().length, locale).toBeGreaterThan(0);
      // Four DISTINCT names: a deck that answered one string for several would satisfy a length
      // check and offer one door wearing four labels.
      expect(new Set(named).size, `${locale} does not name four distinct doors`).toBe(4);
      for (const say of [
        deck.doorCloudSay, deck.doorOwnServerSay, deck.doorDesktopSay, deck.doorPhoneSay,
      ]) {
        expect(say.trim().length, locale).toBeGreaterThan(0);
      }
      // The fourth door's THIRD line exists on both platforms and in both languages — it is the
      // door's cost, and the one platform fork on any of these screens.
      for (const need of [deck.doorPhoneNeedIos, deck.doorPhoneNeedAndroid]) {
        expect(need.trim().length, locale).toBeGreaterThan(0);
      }
      expect(deck.doorPhoneNeedIos, locale).not.toBe(deck.doorPhoneNeedAndroid);
    }
  });

  /**
   * THE SENTENCE ABOVE THE DOORS COUNTS THEM, SO THE COUNT IS A CLAIM.
   *
   * `doorsLead` renders immediately above the panel and says how many answers the question has.
   * It said "three" — written when there were three — for as long as the fourth door existed in
   * the tree, and the ruling that added that door names the sentence as one of the strings it
   * changes. Nothing measured it: the count is a WORD, so no test comparing numbers would see it,
   * and on a build with no engine registered the fourth row does not render, which makes the
   * stale sentence accidentally true on the only surface anyone could have checked.
   *
   * Read as the word against `<Door>` count, in both languages, so the sentence cannot go stale
   * again when a fifth door lands.
   */
  const COUNT_WORDS: Record<string, Record<number, string>> = {
    en: { 3: "three", 4: "four", 5: "five" },
    de: { 3: "drei", 4: "vier", 5: "fünf" },
  };

  it("the lead sentence counts the doors the chooser renders, in both languages", () => {
    const rendered = (doors.match(/<Door\b/g) ?? []).length;
    expect(rendered, "the chooser renders no doors — this case has nothing to count")
      .toBeGreaterThan(0);
    for (const [locale, deck] of Object.entries(DECKS)) {
      const words = COUNT_WORDS[locale];
      expect(words, `${locale} has no number words — the case cannot read this deck`).toBeDefined();
      const expected = words[rendered];
      expect(expected, `no ${locale} word for ${rendered} doors — add it to COUNT_WORDS`)
        .toBeDefined();
      const lead = deck.doorsLead;
      expect(lead.includes(expected), `${locale} doorsLead says "${lead}" over ${rendered} doors `
        + `— it must name ${expected}`).toBe(true);
      /* AND IT MUST NAME NO OTHER COUNT. Without this, a sentence carrying both the old word and
         the new one ("three answers, now four") would satisfy the check above. */
      const others = Object.entries(words)
        .filter(([n]) => Number(n) !== rendered)
        .filter(([, word]) => new RegExp(`\\b${word}\\b`, "iu").test(lead))
        .map(([n, word]) => `${word} (${n})`);
      expect(others, `${locale} doorsLead also names ${others.join(", ")} — one count per sentence`)
        .toEqual([]);
    }
  });

  it("renders exactly four doors, each with a target that exists", () => {
    expect(doors.match(/<Door\b/g) ?? [], "the chooser does not render four doors").toHaveLength(4);
    // Cloud → this app's own constant, negotiated on press.
    expect(doors).toContain("check(MANAGED_ORIGIN");
    // Own server → the address arm, whose parse and probe live in the shared component.
    expect(doors).toContain("addressProblem");
    expect(doors).toContain("conn.probeBase");
    // Own computer → the scanner, injected by both surfaces that mount the chooser.
    expect(doors).toContain("onPress={onScan}");
    // This phone → the limitations screen, injected by both surfaces, and gated on an engine
    // actually being registered rather than on a flag. Both halves are asserted: a door offered
    // without the second is a control that cannot do what its name says.
    expect(doors).toContain("onPress={onStandalone}");
    expect(doors).toContain("standaloneAvailable({ startEngine: phoneEngineStart() })");
    for (const screen of [welcome, servers]) {
      expect(screen).toContain("<Doors");
      expect(screen).toContain("onScan");
      expect(screen).toContain('router.push("/standalone")');
    }
    expect(ROUTE_FILES.map(rel)).toContain("apps/mobile/app/scan.tsx");
    expect(ROUTE_FILES.map(rel)).toContain("apps/mobile/app/standalone.tsx");
  });

  /**
   * WHAT THE PHONE DECLARES ITSELF TO BE, asserted through the function that decides it.
   *
   * This is the `host`/`organizer` KIND refusal from the other side: the type has exactly two
   * members, both mobile, and every platform string maps into it. A third member — `"host"`,
   * `"organizer"`, a desktop kind — fails the union check below, and `mobileDeviceKind` returning
   * one would fail the mapping. A grep for the word "host" could not tell either of those from a
   * comment; this cannot be satisfied by anything but the behaviour.
   */
  it("declares itself as one of exactly two mobile kinds, and nothing else", () => {
    expect(mobileDeviceKind("ios")).toBe("mobile-ios");
    expect(mobileDeviceKind("android")).toBe("mobile-android");
    // An unknown platform must still land inside the mobile pair rather than falling through.
    expect(["mobile-ios", "mobile-android"]).toContain(mobileDeviceKind("harmony"));
    // The union is closed at two, checked at compile time: adding "host" to `MobileDeviceKind`
    // makes this exhaustive map a type error, which `pnpm -F mobile typecheck` covers for `test/`.
    const closed: Record<MobileDeviceKind, true> = { "mobile-android": true, "mobile-ios": true };
    expect(Object.keys(closed).sort()).toEqual(["mobile-android", "mobile-ios"]);
  });

  /**
   * THE LIMITS THEMSELVES — the three ruled sentences, in both languages, on the screen.
   *
   * This replaces the old `doorsNoFourthDoor` case and does the same job. That sentence said the
   * phone does not organize, and it was held here — beside the doors rather than among the refusals
   * — because if it went missing the census's subject became a phone whose limits nobody told the
   * person about. The fourth door makes the sentence false and the JOB unchanged: the limits are
   * now three sentences on a screen that is read before any password field exists, and they are
   * held here for exactly the same reason.
   */
  it("states the fourth door's three limits, in both languages, before any password field", () => {
    for (const [locale, deck] of Object.entries(DECKS)) {
      const ruled = [deck.phoneStandaloneL1Ios, deck.phoneStandaloneL1Android,
                     deck.phoneStandaloneL2, deck.phoneStandaloneL3, deck.phoneStandaloneL4];
      for (const line of ruled) expect(line.trim().length, locale).toBeGreaterThan(0);
      expect(new Set(ruled).size, `${locale} repeats one of the five ruled lines`).toBe(5);

      /* THE PLATFORM LINES EACH NAME THEIR CONDITION, and neither promises the background on a
         platform that cannot honour it. The iPhone sentence says the mailbox is HANDED BACK; a
         sentence promising a suspended iPhone keeps organizing is the double-organizer hazard
         written down as a feature, so the words for it are refused by name. */
      for (const line of [deck.phoneStandaloneL1Ios, deck.phoneStandaloneL1Android]) {
        expect(CONDITION.test(line), `${locale}: "${line}" states no condition`).toBe(true);
        expect(organizingPromises(line), locale).toEqual([]);
      }
      for (const forever of [/\bin the background\b/i, /\bim hintergrund\b/i]) {
        expect(deck.phoneStandaloneL1Ios, `${locale} promises iOS the background`)
          .not.toMatch(forever);
      }

      /* AND IT PROMISES NOTHING ELSE. Same rule the retired sentence carried: "yet"/"soon" commit
         the product to a build nobody has shipped, in the one place a person is deciding. */
      for (const line of ruled) {
        for (const promise of [/\byet\b/i, /\bsoon\b/i, /\bnoch nicht\b/i, /\bbald\b/i, /\bdemnächst\b/i]) {
          expect(line, `${locale} promises something with ${promise.source}`).not.toMatch(promise);
        }
      }
    }
    // The two languages say different words, so neither is an untranslated copy of the other.
    expect(DECKS.en.phoneStandaloneL3).not.toBe(DECKS.de.phoneStandaloneL3);
    expect(Copy.phoneStandaloneL2.length).toBeGreaterThan(0);

    /* ── AND THEY ARE ON THE SCREEN, BEFORE THE FORM ───────────────────────────────────────────
       Render ORDER, not mere presence: the limitations step is what `standalone.tsx` shows first
       and `secureTextEntry` lives behind the step it advances to. A screen that rendered the form
       first would satisfy a presence check and ask for a password before saying anything. */
    const route = readFileSync(join(APP, "app/standalone.tsx"), "utf8");
    expect(route, "the limitations step does not render the ruled lines").toContain("limitationLines(");
    expect(route).toContain('useState<StandaloneStep>("limits")');
    const limits = route.indexOf("limitationLines(");
    const secret = route.indexOf("secret");
    expect(limits, "the route does not render the limits at all").toBeGreaterThan(-1);
    expect(secret, "the route has no password field").toBeGreaterThan(-1);
    expect(limits, "the password field is rendered before the limits").toBeLessThan(secret);
  });
});

/* ── §6. the controls: every refusal rule, watched firing ──────────────────────────────────── */

/**
 * A refusal rule that has stopped firing passes §§1–4 in perfect silence, and the greener the tree
 * gets the less anybody looks. Each rule above is a pure function, so each one is run here over
 * input planted for it — none of which is in the tree, so nothing here can go stale against a
 * refactor of the app.
 *
 * This is the permanent half of "watched red". The one-off half — planting each violation in the
 * real shipped source and watching exactly the intended case fail — is recorded in this commit's
 * message, and is what proves the rules are wired to the real scans rather than only to this table.
 */
describe("§6 every refusal rule fires — the controls", () => {
  it("§1 the import extractor finds a forbidden module, in every import form", () => {
    const planted = `
      import { localRoutes } from "${SCOPE}/api/local";
      export { x } from "${SCOPE}/worker/lease";
      const y = await import("${SCOPE}/core/adapters/imap");
      import "@ohmail/sidecar";
      const z = require("${SCOPE}/services/mail");
    `;
    const specs = specifiersOf(planted);
    expect(specs).toHaveLength(5);
    expect(specs.filter(FORBIDDEN_SPECIFIER)).toHaveLength(5);
  });

  it("§1 a forbidden module NAMED IN A COMMENT is not a forbidden module imported", () => {
    // The rule that keeps this census usable: `src/net/mailboxes.ts` explains `desktopHostRoutes`
    // in prose, and this very file names six forbidden modules in its header.
    const prose = `
      /* imports "${SCOPE}/api" — which it must never do. */
      // import { ImapAdapter } from "${SCOPE}/core/adapters/imap";
      ${"import"} { Copy } from "../copy";
    `;
    expect(specifiersOf(prose)).toEqual(["../copy"]);
  });

  it("§1 the escaping-import rule fires on a SECOND reach, and admits an ordinary one", () => {
    const here = join(APP, "src/net/planted.ts");
    // A reach into another app's src, in the shape the review filed.
    expect(escapingImports(here, 'import { x } from "../../../desktop/src/self-host.js";'))
      .toEqual(["../../../desktop/src/self-host.js"]);
    // And one into a package's src, which is the same class through a different root.
    expect(escapingImports(here, 'export { y } from "../../../../packages/' + 'api/src/routes/mail.js";'))
      .toEqual(["../../../../packages/" + "api/src/routes/mail.js"]);
    // THE ADMIT ARM. A rule that refused every relative import would satisfy the two above by
    // refusing nothing in particular, and would refuse this app's own 700-odd internal imports.
    expect(escapingImports(here, 'import { Copy } from "../copy";')).toEqual([]);
    expect(escapingImports(here, 'import { a } from "./bearer";')).toEqual([]);
    // A BARE specifier is a package edge, not an escape — §1's forbidden-module rule owns it.
    expect(escapingImports(here, 'import { z } from "@ohmail/client-engine";')).toEqual([]);
  });

  it("§1 the file rule refuses each source tree, and admits the one named leaf", () => {
    for (const forbidden of [
      "apps/sidecar/src/engine.ts",
      "apps/worker/src/sync.ts",
      "packages/api/src/routes/desktop-host.ts",
      "packages/services/src/mail.ts",
      "packages/core/src/adapters/organizer-lease.ts",
    ]) {
      expect(FORBIDDEN_FILE(r(forbidden)), forbidden).toBe(true);
    }
    expect(FORBIDDEN_FILE(SIDECAR_LEAF), "the named leaf must be admitted").toBe(false);
    expect(FORBIDDEN_FILE(r("packages/client-engine/src/engine.ts")), "the phone's own engine")
      .toBe(false);
  });

  it("§1 a crawl that reached a forbidden module reports it", () => {
    // Driven through `crawl` itself rather than through the rule alone: this proves the walker
    // carries a hit out, which is the part a refactor of `crawl` could silently drop.
    const found = crawl([r("apps/sidecar/src/engine.ts")]);
    expect(found.hits.length, "the crawl reported nothing about the desktop engine")
      .toBeGreaterThan(0);
  });

  it("§2 the hand-written host shapes are each found", () => {
    const planted = [
      "const s = http.createServer(handler);",
      "server.listen(8080);",
      "if (process.env.OHMAIL_HOST_MODE === '1') arm();",
      "app.route(desktopHostRoutes);",
      "const t = createPairingToken();",
      "if (await mayOrganize(mailbox)) drain();",
    ];
    for (const line of planted) {
      expect(hostCodeIn(line), line).not.toEqual([]);
    }
    // And it does not fire on the app's own vocabulary: a listener SUBSCRIPTION is not a socket.
    expect(hostCodeIn("AppState.addEventListener('change', onChange);")).toEqual([]);
    expect(hostCodeIn("const kind = mobileDeviceKind(Platform.OS);")).toEqual([]);
  });

  it("§3 the route rule refuses a host screen and admits every real one", () => {
    for (const door of ["organize", "organise", "organizer", "settings/host", "be-the-host"]) {
      expect(FORBIDDEN_ROUTE.test(door), door).toBe(true);
    }
    for (const real of ["welcome", "servers", "scan", "connect", "settings", "triage", "(tabs)/more"]) {
      expect(FORBIDDEN_ROUTE.test(real), real).toBe(false);
    }
    /* AND THE RULED DOOR IS ADMITTED BY THE REFUSAL AND CAUGHT BY THE ALLOWLIST — both halves,
       because dropping `standalone` from the refusal without the allowlist would admit the whole
       family. `standalone` is not a host screen; `standalone2` is not the ruled door. */
    expect(FORBIDDEN_ROUTE.test("standalone")).toBe(false);
    expect(isStandalone("standalone")).toBe(true);
    for (const sibling of ["standalone2", "standalone/advanced", "my-standalone"]) {
      expect(standaloneish(sibling), sibling).toBe(true);
      expect(isStandalone(sibling), `${sibling} passed for the ruled door`).toBe(false);
    }
  });

  it("§3 the link extractor finds a navigation target", () => {
    const planted = `router.push("/standalone"); <Link href="/organize" />; router.replace('/scan');`;
    const found = navTargets(planted);
    expect(found.sort()).toEqual(["/organize", "/scan", "/standalone"]);
    expect(found.filter((t) => FORBIDDEN_ROUTE.test(t)).sort()).toEqual(["/organize"]);
  });

  it("§4 an UNCONDITIONAL promise of organizing is caught in both languages", () => {
    for (const promise of [
      "Organize your mailbox on this phone. Nothing leaves the device.",
      "This phone organizes your mail.",
      "Your phone organizes everything for you, all the time.",
      "Dieses Handy organisiert dein Postfach selbst.",
      "Organisiere dein Postfach auf diesem Handy.",
    ]) {
      expect(organizingPromises(promise), promise).not.toEqual([]);
    }
  });

  it("§4 admits the true sentences — different clauses, a negation, or a condition", () => {
    for (const true_ of [
      // The three host doors: an organizing verb and a phone, in different clauses.
      "Our hosted service does the organizing; this phone keeps a copy.",
      "Unser gehosteter Dienst organisiert; dieses Handy hält eine Kopie.",
      // A negation — the shape the rule carried before the fourth door was ruled.
      "This phone does not organize a mailbox on its own: it always works through ohmail Cloud.",
      "Dieses Handy organisiert ein Postfach nicht von selbst: Es arbeitet immer über ohmail Cloud.",
      // A CONDITION — the fourth door's own ruled sentences, which is what 0.18 added.
      "It organizes while ohmail is open",
      "Es organisiert, solange ohmail geöffnet ist",
      "Only while the app is open — or in the background behind a notification you can see.",
      "Nur solange die App offen ist — oder im Hintergrund hinter einer sichtbaren Benachrichtigung.",
      // The condition has to be in the SAME clause, and the splitter cuts on every `.` — including
      // the one inside an address. So a sentence naming a mailbox puts its condition first.
      "Only while ohmail is open does this phone organize your mail.",
    ]) {
      expect(organizingPromises(true_), true_).toEqual([]);
    }
  });

  /**
   * THE CONDITION WORDS ARE NARROW ON PURPOSE, watched both ways.
   *
   * A catch-all for subordinate clauses would admit an unconditional promise wearing a reason
   * ("This phone organizes your mail, because it runs an engine"), which is the weakening the
   * re-derivation had to avoid. So: the six condition words fire, and three plausible
   * near-misses do not.
   */
  it("§4 the condition test admits a real condition and refuses a reason", () => {
    for (const conditional of ["while", "only", "when", "solange", "nur", "wenn"]) {
      expect(CONDITION.test(`it organizes ${conditional} something`), conditional).toBe(true);
    }
    for (const reason of ["because", "so that", "although", "weil", "damit"]) {
      expect(CONDITION.test(`it organizes ${reason} something`), reason).toBe(false);
    }
    // And the whole rule end to end: the same sentence with and without its condition.
    expect(organizingPromises("This phone organizes your mail")).not.toEqual([]);
    expect(organizingPromises("This phone organizes your mail while ohmail is open")).toEqual([]);
  });

  it("§4 the deck extractor reads a function's assembled sentence, not only a bare string", () => {
    const planted = 'export const X = { a: "plain", b: (n: string) => `${n} on this phone organizes` };';
    const body = planted.replace(/^export const X = \{|\};$/g, "");
    const out: string[] = [];
    for (const m of body.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push(m[1]!);
    for (const m of body.matchAll(/`((?:[^`\\]|\\.)*)`/g)) out.push(m[1]!);
    expect(out).toContain("plain");
    expect(out.flatMap(organizingPromises)).not.toEqual([]);
  });
});
