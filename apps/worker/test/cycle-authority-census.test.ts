import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { cycleWriteAuthority, type LeasePermit } from "../src/lease.js";

/**
 * ONE COMPOSITION OF A CYCLE'S AUTHORITY, IN EVERY ROOT. The hosted worker handed `runSyncCycle`
 * the runtime's permit whatever its gate answered, so a reader cycle rode the attach seed or a
 * permit from before its demotion (`reader-cycle-authority.pg.test.ts` measures both). Every
 * production `runSyncCycle({ … })` names `writeAuthority: cycleWriteAuthority(<role>, …)` whose
 * role is the call's own `role:` value — or `<deps>.role` when the role arrives in a spread — so
 * the role and the authority cannot disagree. Scanned: every `src` under `apps/` and `packages/`.
 */

const REPO = resolve(__dirname, "../../..");
const COMPOSE = "cycleWriteAuthority";

function productionFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === "dist" || e === "test" || e === "__tests__") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.tsx?$/.test(p) && !/\.d\.ts$|\.test\.tsx?$/.test(p)) out.push(p);
    }
  };
  for (const bucket of ["apps", "packages"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      const src = join(REPO, bucket, name, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src */ }
    }
  }
  return out.sort();
}

interface Composition { readonly where: string; readonly verdict: "ok" | string }

/** Every `runSyncCycle({ … })` in one source, judged by the one rule. A non-literal argument forwards. */
function compositionsIn(file: string, text: string): Composition[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Composition[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "runSyncCycle") {
      const arg = n.arguments[0];
      const where = `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
      if (arg !== undefined && ts.isObjectLiteralExpression(arg)) {
        const prop = (name: string): ts.Expression | undefined => {
          for (const p of arg.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText() === name) return p.initializer;
          }
          return undefined;
        };
        const spread = arg.properties.filter(ts.isSpreadAssignment).map((s) => s.expression.getText());
        const role = prop("role")?.getText();
        const auth = prop("writeAuthority");
        let verdict: string;
        if (auth === undefined) verdict = "names no writeAuthority";
        else if (!ts.isCallExpression(auth) || auth.expression.getText() !== COMPOSE || auth.arguments.length !== 2) {
          verdict = `writeAuthority is \`${auth.getText()}\`, not ${COMPOSE}(<role>, <permit>)`;
        } else {
          const said = auth.arguments[0]!.getText();
          const fromSpread = role === undefined && spread.some((s) => said === `${s}.role`);
          verdict = said === role || fromSpread ? "ok" : `the authority's role \`${said}\` is not the call's role \`${role ?? "(spread)"}\``;
        }
        out.push({ where, verdict });
      }
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(sf, walk);
  return out;
}

describe("every cycle's authority is composed from its own role, by one function", () => {
  const found = productionFiles().flatMap((f) => compositionsIn(f.slice(REPO.length + 1), readFileSync(f, "utf8")));

  it("the three composing roots are the known ones, and each composes through the one function", () => {
    expect({ refused: found.filter((c) => c.verdict !== "ok").map((c) => `${c.where}: ${c.verdict}`) })
      .toEqual({ refused: [] });
    // Five calls in three roots: the hosted worker, the reconcile backstop (two cycles), the local
    // engine (its drain, and a read press's `\Seen`-only cycle).
    expect(found.map((c) => c.where.replace(/:\d+$/, "")).sort()).toEqual([
      "apps/sidecar/src/engine.ts", "apps/sidecar/src/engine.ts", "apps/worker/src/index.ts",
      "apps/worker/src/reconcile-cron.ts", "apps/worker/src/reconcile-cron.ts",
    ]);
  });

  it("a planted root that hands the runtime's permit, or a role the call does not say, reads red", () => {
    const planted = (body: string) => compositionsIn("planted.ts", `runSyncCycle({ ${body} });`)[0]!.verdict;
    expect(planted("...rt.deps, role: rt.role, writeAuthority: rt.leasePermit")).toMatch(/not cycleWriteAuthority/);
    expect(planted(`role: rt.role, writeAuthority: cycleWriteAuthority("organizer", rt.leasePermit)`)).toMatch(/is not the call's role/);
    expect(planted("...deps, writeAuthority: cycleWriteAuthority(other.role, permit)")).toMatch(/is not the call's role/);
    expect(planted("role: rt.role")).toBe("names no writeAuthority");
    // The admitting controls: the call's own role, and a role that arrives in the spread.
    expect(planted("role: rt.role, writeAuthority: cycleWriteAuthority(rt.role, rt.leasePermit)")).toBe("ok");
    expect(planted("...deps, writeAuthority: cycleWriteAuthority(deps.role, permit)")).toBe("ok");
  });

  it("the function has one definition, and a reader never rides the permit it is handed", () => {
    const defs = productionFiles().filter((f) => new RegExp(`export function ${COMPOSE}\\b`).test(readFileSync(f, "utf8")));
    expect(defs.map((f) => f.slice(REPO.length + 1))).toEqual(["apps/worker/src/lease.ts"]);
    const permit = { standing: () => "held" } as unknown as LeasePermit;
    expect(cycleWriteAuthority("organizer", permit)).toBe(permit);
    expect(cycleWriteAuthority("reader", permit)).toEqual({ noLease: "reader" });
  });
});
