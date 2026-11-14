import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE BELT OVER THE REQUIRED `onCallFault` — every host client under `apps/<app>/src` states its fault
 * recorder in the options it is built with, and none takes the `"unrecorded"` opt-out outside the
 * allow list below. The compiler is the gate; this names a call whose options come from elsewhere.
 */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Host compositions admitted to record nothing, each with its reason. Empty: every host counts. */
const UNRECORDED_ALLOWED: ReadonlyArray<{ file: string; reason: string }> = [];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "build") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

interface Finding { line: number; problem: string }

/** Every `makeEntitlementsClient(` call in one source, and what is wrong with its options. */
export function clientCalls(file: string, text: string): { calls: number; findings: Finding[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let calls = 0;
  const findings: Finding[] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "makeEntitlementsClient") {
      calls++;
      const arg = n.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        findings.push({ line: lineOf(n), problem: "options are not an object literal here" });
      } else {
        const hook = arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === "onCallFault");
        if (!hook || !ts.isPropertyAssignment(hook)) findings.push({ line: lineOf(n), problem: "no onCallFault" });
        else if (/^("unrecorded"|CALL_FAULT_UNRECORDED)$/.test(hook.initializer.getText(sf).trim())) {
          findings.push({ line: lineOf(n), problem: "unrecorded" });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { calls, findings };
}

describe("every host entitlements client records its failed calls", () => {
  const files = readdirSync(join(ROOT, "apps")).flatMap((app) => {
    const src = join(ROOT, "apps", app, "src");
    try { return statSync(src).isDirectory() ? sources(src) : []; } catch { return []; }
  });
  const read = files.map((f) => ({ file: relative(ROOT, f), ...clientCalls(f, readFileSync(f, "utf8")) }))
    .filter((r) => r.calls > 0);

  it("finds the five host compositions — a census that finds none measured nothing", () => {
    expect(read.map((r) => r.file).sort()).toEqual([
      "apps/server/src/deps.ts",
      "apps/worker/src/index.ts",
      "apps/worker/src/proposal-cron.ts",
      "apps/worker/src/reconcile-cron.ts",
      "apps/worker/src/workflow-cron.ts",
    ]);
  });

  it("each names its recorder in the options, and none is unrecorded outside the allow list", () => {
    const allowed = new Set(UNRECORDED_ALLOWED.map((a) => a.file));
    const refused = read.flatMap((r) => r.findings
      .filter((f) => !(f.problem === "unrecorded" && allowed.has(r.file)))
      .map((f) => `${r.file}:${f.line} ${f.problem}`));
    expect(refused).toEqual([]);
  });

  // The CALL in code, comments blanked: a recorder named only in a comment records nothing.
  const callsSharedRecorder = (src: string): boolean => /\bentitlementsFaultRecorder\(/.test(withoutComments(src));

  it("every host composition records through the one shared recorder, never a spelling of its own", () => {
    const own = read.filter((r) => !callsSharedRecorder(readFileSync(join(ROOT, r.file), "utf8")))
      .map((r) => r.file);
    expect(own, "a second spelling of the row and its log line drifts from the first").toEqual([]);
  });

  it("control: a recorder named only in a comment is not a call", () => {
    expect(callsSharedRecorder("onCallFault: ownWriter, // was entitlementsFaultRecorder(db, \"api\")")).toBe(false);
    expect(callsSharedRecorder("/* entitlementsFaultRecorder( */ onCallFault: ownWriter")).toBe(false);
    expect(callsSharedRecorder("onCallFault: entitlementsFaultRecorder(db, \"api\")")).toBe(true);
  });

  it("the census refuses each shape it exists for (planted)", () => {
    const planted = [
      "makeEntitlementsClient({ baseUrl, secret });",
      "makeEntitlementsClient({ baseUrl, secret, onCallFault: \"unrecorded\" });",
      "makeEntitlementsClient(bag);",
      "makeEntitlementsClient({ baseUrl, secret, onCallFault: record });",
    ].join("\n");
    expect(clientCalls("planted.ts", planted).findings.map((f) => f.problem)).toEqual([
      "no onCallFault", "unrecorded", "options are not an object literal here",
    ]);
  });
});
