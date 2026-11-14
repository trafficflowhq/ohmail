import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, lineOf, withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY CALLER HANDS THE ACT ITS OWN CONSENT, AND NOTHING ELSE. `screenerAutoActPass` files a
 * sender on a stored model suggestion; its only arming is `deps.consent`, and every production
 * call builds it with `screenerActConsentFrom(accountId)` — `screener_auto_act_at` joined with
 * `accounts.ai_enabled`. The pass asks the consent before any other read.
 * Exact set, both directions.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const PASS = ["apps", "worker", "src", "screener-auto-act.ts"].join(sep);

/** Every production call, by file, and how many each makes. */
const CALLERS: Record<string, number> = {
  [["apps", "worker", "src", "index.ts"].join(sep)]: 2,
  [["apps", "sidecar", "src", "engine.ts"].join(sep)]: 1,
};

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".next", "coverage", "build"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

function roots(): string[] {
  const out: string[] = [];
  for (const bucket of ["apps", "packages"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      for (const sub of ["src", "app"]) {
        const p = join(REPO, bucket, name, sub);
        try { if (statSync(p).isDirectory()) out.push(p); } catch { /* no such subdir */ }
      }
    }
  }
  return out;
}

interface Call { at: number; args: string; closed: boolean }

/** Each CALL of the pass in one source text, comments blanked; the definition is not a call. */
function callsIn(src: string): Call[] {
  const code = withoutComments(src);
  const out: Call[] = [];
  for (const m of code.matchAll(/\bscreenerAutoActPass\s*\(/g)) {
    if (/function\s*$/.test(code.slice(0, m.index))) continue;
    const s = bracketSpan(code, m.index + m[0].length - 1);
    out.push({ at: m.index, args: code.slice(s.start, s.end), closed: s.closed });
  }
  return out;
}

/** The one consent a caller may bring: the constructor's, built for an account in the call. */
const bringsItsConsent = (c: Call): boolean =>
  c.closed && /\bconsent:\s*screenerActConsentFrom\(\s*[\w.]+\s*\)/.test(c.args);

describe("the act's callers hand it the constructor's consent and nothing else", () => {
  it("the checker admits the constructor, refuses null, a hand-made consent and a commented one", () => {
    const ok = callsIn("await screenerAutoActPass(db, { accountId, consent: screenerActConsentFrom(accountId) }, now);");
    expect(ok.map(bringsItsConsent)).toEqual([true]);
    expect(callsIn("screenerAutoActPass(db, { accountId, consent: screenerActConsentFrom(world.accountId) });")
      .map(bringsItsConsent)).toEqual([true]);
    expect(callsIn("screenerAutoActPass(db, { accountId, consent: null });").map(bringsItsConsent)).toEqual([false]);
    expect(callsIn("screenerAutoActPass(db, { accountId, consent: GIVEN });").map(bringsItsConsent)).toEqual([false]);
    expect(callsIn("screenerAutoActPass(db, { accountId /* consent: screenerActConsentFrom(a) */ });")
      .map(bringsItsConsent)).toEqual([false]);
    expect(callsIn("export async function screenerAutoActPass(db: Tx, deps: Deps) {}")).toEqual([]);
  });

  it("every production call is named here and brings `screenerActConsentFrom`", () => {
    const seen: Record<string, number> = {};
    const refused: string[] = [];
    for (const root of roots()) {
      for (const file of walk(root)) {
        const src = readFileSync(file, "utf8");
        if (!src.includes("screenerAutoActPass")) continue;
        const rel = relative(REPO, file);
        for (const c of callsIn(src)) {
          seen[rel] = (seen[rel] ?? 0) + 1;
          if (!bringsItsConsent(c)) refused.push(`${rel}:${lineOf(src, c.at)}`);
        }
      }
    }
    // POSITIVE CONTROL: three real calls are found, so a zero below is a reading.
    expect(seen, "the set of callers moved — name the new one, and its consent, here").toEqual(CALLERS);
    expect(refused, "a caller hands the act a consent other than the constructor's").toEqual([]);
  });

  it("the pass asks the consent before any read", () => {
    const code = withoutComments(readFileSync(join(REPO, PASS), "utf8"));
    const body = code.slice(code.indexOf("export async function screenerAutoActPass"));
    const probe = body.indexOf("if (!(await consent.stillGiven(db))) return EMPTY();");
    expect(probe, "the consent probe is gone").toBeGreaterThan(0);
    expect(probe).toBeLessThan(body.indexOf(".select("));
  });

  it("the constructor reads the act's own column and the account's AI switch, in one statement", () => {
    const code = withoutComments(readFileSync(join(REPO, PASS), "utf8"));
    const at = code.indexOf("export function screenerActConsentFrom");
    expect(at, "the constructor is gone").toBeGreaterThan(0);
    const ctor = code.slice(at, code.indexOf("\n}\n", at));
    expect(ctor).toMatch(/isNotNull\(accountSettings\.screenerAutoActAt\)/);
    expect(ctor).toMatch(/eq\(accounts\.aiEnabled, true\)/);
    expect(ctor.match(/\.select\(/g)?.length, "one statement").toBe(1);
  });
});
