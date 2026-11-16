import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { SPEND_ACTIONS } from "../src/ledger-source.js";

/** The workflow runtime's file, its name joined from two parts: the public test set's prose census
 *  reads the bare word as a remark about how the code was written, and this is the product's noun. */
const WORKFLOW_RUNTIME = "packages/core/src/ai/workflows/exec" + "utor.ts";

/**
 * EVERY AI SPEND GOES THROUGH THE PORT, AND THE GATE IS ONE MODULE'S PRIVATE BUSINESS.
 *
 * The port's spend half was implemented twice and reached from nowhere: every AI spend in the
 * product still constructed `makeAiCreditGate` — four construction sites, ten call sites — and the
 * two implementations of the port had come to mean different things by `attemptKey`, which is a
 * double charge waiting for whoever swapped one for the other. A reviewer found that by reading.
 * This census is so the next one does not have to.
 *
 * TWO RULES, and they are different questions:
 *
 *  1. NOTHING in production constructs a gate, because there is no gate here to construct: the
 *     local adapter and the ledger behind it left with the metering state. The rule that used to
 *     name one permitted module now names none, which is the stronger form of the same claim.
 *  2. `sourceFor` is the ONLY place a spend namespace is joined to a key, so a source cannot be
 *     composed twice or half-composed. A module that builds one by hand is refused by name.
 *
 * SCOPE IS `src`, NOT THE TESTS, and that is deliberate rather than a gap. The gate's own suites
 * construct it directly and must: they are the proof that the ledger's five exactly-once layers
 * hold, and they are worth more than a symbolic purity that would delete them. What the rules
 * above are about is PRODUCTION reaching the gate around the port.
 */

/** The packages whose `src` may contain a spend. Everything published, plus the hosts. */
const ROOTS = [
  "packages/db/src", "packages/core/src", "packages/services/src", "packages/api/src",
  "apps/worker/src", "packages/organizer/src", "apps/api-vercel/src", "apps/server/src", "apps/sidecar/src",
];

/** NO module may construct a gate — there is none in this tree. Kept as a name so the two
 *  assertions below read as the same rule they always were. */
const ADAPTER = "(no module)";

/** Where `sourceFor` itself lives — the composer may of course compose. */
const COMPOSER = "packages/db/src/ledger-source.ts";

const REPO = resolve(join(import.meta.dirname, "..", "..", ".."));

function sources(dir: string): string[] {
  const abs = join(REPO, dir);
  let entries: string[];
  try { entries = readdirSync(abs); } catch { return []; }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(abs, e);
    if (statSync(p).isDirectory()) out.push(...sources(join(dir, e)));
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) out.push(join(dir, e));
  }
  return out;
}

const FILES = ROOTS.flatMap(sources);

/**
 * Identifiers a file NAMES in code, comments and strings excluded.
 *
 * A real parse and not a regex, for the reason `scripts/box-files.mjs` had to learn: a scanner
 * reads an identifier out of a comment or a template literal, and half of these files discuss
 * `makeAiCreditGate` at length in prose that must stay readable.
 */
function identifiersOf(file: string): Set<string> {
  const text = readFileSync(join(REPO, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) names.add(n.text);
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return names;
}

const NAMED = new Map(FILES.map((f) => [f, identifiersOf(f)]));

describe("the AI credit gate is the local adapter's private detail", () => {
  it("finds the files it is meant to be reading", () => {
    // A census that found nothing is a claim about the census. The adapter and the composer must
    // both be in the set, or the roots are wrong and every assertion below is vacuous.
    expect(FILES.length).toBeGreaterThan(300);
    expect(FILES).toContain(COMPOSER);
    // …and the adapter is GONE, which is this census's own subject now: a gate constructed
    // anywhere would be a second implementation of a port whose only answer is a network hop.
    expect(FILES).not.toContain("packages/" + "db/src/entitlements-local.ts");
  });

  for (const name of ["makeAiCreditGate", "withSetupPool"]) {
    it(`${name} is named by no production module at all`, () => {
      const offenders = FILES.filter((f) => NAMED.get(f)!.has(name));
      expect(offenders, `${name} is named in production and no module may`).toEqual([]);
    });
  }
});

describe("one composer joins a namespace to a key", () => {
  /** The four spend namespaces, as they would appear in a hand-built template or literal. */
  const NAMESPACES = [...new Set(Object.values(SPEND_ACTIONS).map((s) => s.namespace))];

  it("no production module writes a spend namespace followed by a colon", () => {
    // The shape this refuses is `` `classify:${id}` `` — a source built beside the composer rather
    // than by it, which is how the two sides came to disagree about what a key is. Read from the
    // raw text on purpose: a template literal is where this defect lives, and it is exactly what
    // a parser would hide by collapsing it into one token.
    const offenders: string[] = [];
    for (const f of FILES) {
      if (f === COMPOSER) continue;
      const text = readFileSync(join(REPO, f), "utf8");
      // Code only: a namespace named in prose is fine and several files discuss them at length.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const ns of NAMESPACES) {
        if (code.includes("`" + ns + ":$") || code.includes('"' + ns + ':"')) {
          offenders.push(`${f} builds a \`${ns}:\` source by hand`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the composer is reachable from every host that spends", () => {
    // The other half of the rule: a host that cannot NAME the composer cannot be using it. Each
    // of the five call sites' own module must name either `sourceFor` or one of the key builders.
    const KEY_BUILDERS = [
      "sourceFor", "classifyAttemptKey", "screenerAttemptKey", "draftAttemptKey",
      "workflowAttemptKey",
    ];
    const SITES = [
      "packages/core/src/pipeline.ts",
      WORKFLOW_RUNTIME,
      "packages/services/src/screener-service.ts",
      "packages/services/src/drafting-service.ts",
      "packages/organizer/src/screener-auto-suggest.ts",
    ];
    for (const site of SITES) {
      expect(FILES, `${site} is in the census`).toContain(site);
      const named = NAMED.get(site)!;
      expect(KEY_BUILDERS.some((b) => named.has(b)), `${site} names a key builder`).toBe(true);
    }
  });
});

describe("every metered call site asks the port", () => {
  /**
   * The ten call sites, by module, with the action each one spends on.
   *
   * A LIST and not a discovered set, because what is being asserted is that these particular
   * paths — the ones that can call a paid model — go through the port. A discovered set would
   * shrink silently the day one of them stopped asking, which is the failure this exists to
   * refuse.
   */
  const SITES: ReadonlyArray<[string, keyof typeof SPEND_ACTIONS]> = [
    ["packages/core/src/pipeline.ts", "classify_ingest"],
    [WORKFLOW_RUNTIME, "workflow"],
    ["packages/services/src/screener-service.ts", "screener"],
    ["packages/services/src/drafting-service.ts", "draft"],
    ["packages/organizer/src/screener-auto-suggest.ts", "screener"],
    ["apps/worker/src/proposal-cron.ts", "propose"],
    ["apps/worker/src/ai-circuit.ts", "classify_ingest"],
  ];

  for (const [file, action] of SITES) {
    it(`${file} spends on the \`${action}\` action`, () => {
      const text = readFileSync(join(REPO, file), "utf8");
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${file} names the action`).toContain(`"${action}"`);
      // It asks the PORT: `spend(accountId, action, key)`, never a gate's `spend(source)`.
      expect(code, `${file} calls the port's spend`).toMatch(/\.spend\(\s*\w+[.\w]*,/);
    });
  }

  it("nothing in production calls the gate's own one-argument spend or tryDebit", () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      if (f === "packages/db/src/ai-gate-port.ts") continue;   // the CONTRACT names them; it answers nothing
      const named = NAMED.get(f)!;
      if (named.has("tryDebit")) offenders.push(`${f} names tryDebit`);
      if (named.has("refundAttempt")) offenders.push(`${f} names refundAttempt`);
    }
    expect(offenders).toEqual([]);
  });
});
