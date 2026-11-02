import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY FINISHED COMPOSITION WIRES THE SSRF GUARD (review 020, BACKEND L2). `probeHostGuardFor`
 * defaults to `ALLOW_ANY_PROBE_HOST` when a deps bag omits the key — deliberate for the local
 * desktop door, where a LAN mail server is the product — but nothing refused a FUTURE hosted
 * composition that simply forgets it, and a forgotten key on a multi-tenant network is an open
 * probe to loopback and private ranges. A finished composition is one that declares
 * `entitlementsPort` (absence of THAT member means nobody finished the bag — apps/server/deps.ts
 * states the convention), so the census pairs the two at file level: a bag file declaring
 * `entitlementsPort:` must wire `probeHostGuard:` with `makeProbeHostGuard(…)` parsed as a CALL;
 * `ALLOW_ANY_PROBE_HOST` is admitted only beside that call (an explicit operator opt-out arm,
 * apps/server's shape) or in the named local door (apps/sidecar/src/engine.ts). RUN BY NAME when
 * apps/api-vercel, apps/server or apps/sidecar move — touched-package selection cannot see
 * across roots into this file.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const ROOT = join(REPO, "apps");

/** The one composition allowed a bare allow-any: the local single-user door. */
const LOCAL_DOOR = "apps/sidecar/src/engine.ts";

/**
 * A bag declares the member in two spellings: the literal key (`entitlementsPort:`, server and
 * sidecar) and the lazy string key (`lazily(bag, "entitlementsPort", …)`, api-vercel). Both count
 * — missing the second read the managed bag as unfinished and swept nothing there.
 */
const DECLARES_PORT = /\bentitlementsPort\s*:|["']entitlementsPort["']/;

function sources(dir: string, into: { file: string; code: string }[] = []): { file: string; code: string }[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "build" || name === "test") continue;
      sources(p, into);
    } else if (extname(name) === ".ts" && !name.endsWith(".test.ts")) {
      into.push({ file: relative(REPO, p), code: withoutComments(readFileSync(p, "utf8")) as string });
    }
  }
  return into;
}

/** Only src trees compose bags; skip everything else an app carries. */
function appSrcFiles(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  for (const app of readdirSync(ROOT)) {
    const src = join(ROOT, app, "src");
    if (existsSync(src) && statSync(src).isDirectory()) sources(src, out);
  }
  return out;
}

/**
 * The classifier, factored so the synthetic-offender arms drive the same code the sweep runs.
 * Returns the refusals for one file's text; [] admits it.
 */
function compositionOffenses(file: string, code: string): string[] {
  if (!DECLARES_PORT.test(code)) return [];
  const out: string[] = [];
  const wiresGuard = /\bprobeHostGuard\s*:/.test(code);
  const enforcingCall = /\bmakeProbeHostGuard\s*\(/.test(code);
  const allowAny = /\bALLOW_ANY_PROBE_HOST\b/.test(code);
  if (!wiresGuard) {
    out.push(`${file}: declares entitlementsPort but never wires probeHostGuard — `
      + "the bag would take the local-safe ALLOW_ANY default on a finished composition");
  } else if (allowAny && !enforcingCall && file !== LOCAL_DOOR) {
    out.push(`${file}: wires ALLOW_ANY_PROBE_HOST with no makeProbeHostGuard arm — `
      + `a bare allow-any belongs only to the local door (${LOCAL_DOOR})`);
  } else if (!allowAny && !enforcingCall) {
    out.push(`${file}: probeHostGuard wired to an expression this census cannot classify — refused by name`);
  }
  return out;
}

describe("probe-host guard composition census", () => {
  const files = appSrcFiles();
  const bags = files.filter((f) => DECLARES_PORT.test(f.code));

  it("every entitlements-declaring composition wires the guard", () => {
    // Vacuity guard: the three known compositions exist, by name.
    const names = bags.map((b) => b.file).sort();
    for (const expected of ["apps/api-vercel/src/deps.ts", "apps/server/src/deps.ts", LOCAL_DOOR]) {
      expect(names, `the ${expected} composition is swept`).toContain(expected);
    }
    const offenses = bags.flatMap((b) => compositionOffenses(b.file, b.code));
    expect(offenses, "compositions whose probe-host posture is open or unstated").toEqual([]);
  });

  it("the hosted deployment's guard is unconditional and the self-host opt-out keeps both arms", () => {
    const vercel = bags.find((b) => b.file === "apps/api-vercel/src/deps.ts")!;
    expect(/\bmakeProbeHostGuard\s*\(/.test(vercel.code)).toBe(true);
    // The managed bag never spells allow-any at all: there is no operator to opt out.
    expect(/\bALLOW_ANY_PROBE_HOST\b/.test(vercel.code)).toBe(false);

    const server = bags.find((b) => b.file === "apps/server/src/deps.ts")!;
    expect(/\bmakeProbeHostGuard\s*\(/.test(server.code)).toBe(true);
    expect(/\bALLOW_ANY_PROBE_HOST\b/.test(server.code)).toBe(true);
  });

  it("refuses the forgetful and bare-allow-any compositions, admits the wired ones (positive control)", () => {
    const bag = (members: string) => withoutComments(`
      export function buildServices(): ApiServices {
        return { ${members} };
      }
    `) as string;

    // The exact future L2 names: a finished bag with no guard key.
    const forgot = bag("entitlementsPort: UNMETERED, mailbox: makeMailboxService({})");
    expect(compositionOffenses("apps/future/src/deps.ts", forgot).length).toBeGreaterThan(0);

    // A bare allow-any outside the local door.
    const bare = bag("entitlementsPort: UNMETERED, probeHostGuard: ALLOW_ANY_PROBE_HOST");
    expect(compositionOffenses("apps/future/src/deps.ts", bare).length).toBeGreaterThan(0);
    // …but the local door itself is admitted with the same text.
    expect(compositionOffenses(LOCAL_DOOR, bare)).toEqual([]);

    // An unclassifiable guard expression is refused, never admitted by silence.
    const odd = bag("entitlementsPort: UNMETERED, probeHostGuard: someOtherGuard");
    expect(compositionOffenses("apps/future/src/deps.ts", odd).length).toBeGreaterThan(0);

    // The two ordinary shapes are admitted.
    const enforcing = bag("entitlementsPort: metered(), probeHostGuard: makeProbeHostGuard(nodeHostResolver)");
    expect(compositionOffenses("apps/future/src/deps.ts", enforcing)).toEqual([]);
    const optOut = bag(
      "entitlementsPort: UNMETERED, probeHostGuard: cfg.allow ? ALLOW_ANY_PROBE_HOST : makeProbeHostGuard(r)",
    );
    expect(compositionOffenses("apps/future/src/deps.ts", optOut)).toEqual([]);

    // A file with no entitlementsPort is not a finished composition — out of the census's set.
    expect(compositionOffenses("apps/future/src/other.ts", bag("mailbox: m()"))).toEqual([]);
  });
});

/**
 * the ONE CALLER. `localServerDial` gives a loopback host the sync dial's 150 s wait, and only the
 * desktop's local door may pass it: on Cloud or self-host the probe holds an admission slot whose
 * stale window is 90 s. The sweep reads every src tree under apps/ and packages/ for the key as a
 * PASSED property (an object member or a shorthand); the declaration (`?:`) and reads (`.x`) are not.
 */
const PASSES_LOCAL_DIAL = /(?<![.?\w])localServerDial\s*:|[{,]\s*localServerDial\s*[,}]/g;

function passesOf(code: string): number {
  return [...code.matchAll(PASSES_LOCAL_DIAL)].length;
}

function srcTreesUnder(root: string): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  for (const pkg of readdirSync(root)) {
    const src = join(root, pkg, "src");
    if (existsSync(src) && statSync(src).isDirectory()) sources(src, out);
  }
  return out;
}

describe("localServerDial census — passed by the desktop's local door only", () => {
  const files = [...srcTreesUnder(ROOT), ...srcTreesUnder(join(REPO, "packages"))];

  it("exactly one file passes it, once, and it is the local door", () => {
    // Vacuity guard: the option is declared where the probe is built, so the sweep reads that tree.
    const probe = files.find((f) => f.file === "packages/api/src/imap-probe.ts");
    expect(probe?.code, "the probe source is swept").toMatch(/\blocalServerDial\?:/);
    const passing = files.filter((f) => passesOf(f.code) > 0).map((f) => `${f.file} x${passesOf(f.code)}`);
    expect(passing).toEqual([`${LOCAL_DOOR} x1`]);
  });

  it("refuses a planted second caller and admits the declaration and a read (positive control)", () => {
    expect(passesOf("makeImapProbe(deps, { localServerDial: WORKER_NET_TIMEOUTS })")).toBe(1);
    expect(passesOf("const o = { countFolders: true, localServerDial };")).toBe(1);
    expect(passesOf("interface X { localServerDial?: NetTimeouts }")).toBe(0);
    expect(passesOf("const local = opts.localServerDial && ok;")).toBe(0);
  });
});

/**
 * THE ONE CALLER of `loopbackCertificate`, on the `localServerDial` census's terms: trusting a
 * server's own certificate is the desktop's local door's alone (a gateway such as Proton Mail Bridge
 * on that computer), never a hosted door's, a self-hosted server's or the phone's.
 */
const PASSES_LOOPBACK_TRUST = /(?<![.?\w])loopbackCertificate\s*:|[{,]\s*loopbackCertificate\s*[,}]/g;

describe("loopbackCertificate census — passed by the desktop's local door only", () => {
  const files = [...srcTreesUnder(ROOT), ...srcTreesUnder(join(REPO, "packages"))];
  const passes = (code: string): number => [...code.matchAll(PASSES_LOOPBACK_TRUST)].length;

  it("exactly one file passes it, once, and it is the local door", () => {
    const probe = files.find((f) => f.file === "packages/api/src/imap-probe.ts");
    expect(probe?.code, "the probe source is swept").toMatch(/\bloopbackCertificate\?:/);
    expect(files.filter((f) => passes(f.code) > 0).map((f) => `${f.file} x${passes(f.code)}`)).toEqual([`${LOCAL_DOOR} x1`]);
  });

  it("refuses a planted second caller and admits the declaration and a read (positive control)", () => {
    expect(passes("makeSmtpProbe(deps, { loopbackCertificate: read })")).toBe(1);
    expect(passes("interface X { loopbackCertificate?: Reader }")).toBe(0);
    expect(passes("const r = opts.loopbackCertificate;")).toBe(0);
  });
});

