import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { WriteDeclinedError, type MailboxWriteKind } from "@trafficflow/core/adapters/imap";
import { assertMayWriteToMailbox, writeDoorOf, type NoOrganizerLease } from "../src/lease.js";
import { FIXTURE_AUTHORITY, FIXTURE_DOOR } from "./_door.js";

/**
 * A WRITE WITH NO LEASE IS REFUSED, AND ONLY A TEST CAN RIDE A LEASE IT DID NOT TAKE. The census
 * reads, by parse, every production path into an organizer write or the page check across every
 * `src` under `apps/` and `packages/`: each hand-in of an authority, each call of the two guards
 * with what it is handed, and each no-lease construction. A seeded carrier reaches a guard only
 * under its gate's organize answer; `not_supplied` is constructed at four named defaults, each
 * refused at both guards; the fixture lease (`_door.ts`) is imported by no `src/` file.
 */

const REPO = resolve(__dirname, "../../..");
const ALL: MailboxWriteKind[] = ["move", "expunge", "seen", "folder_create", "folder_rename", "folder_delete", "folder_sweep"];

function productionSources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === "dist" || e === "test" || e === "__tests__") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (/\.tsx?$/.test(p) && !/\.d\.ts$|\.test\.tsx?$/.test(p)) out.push({ rel: p.slice(REPO.length + 1), text: readFileSync(p, "utf8") });
    }
  };
  for (const bucket of ["apps", "packages"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      const src = join(REPO, bucket, name, "src");
      try { if (statSync(src).isDirectory()) walk(src); } catch { /* no src */ }
    }
  }
  return out;
}

function fnOf(n: ts.Node): string {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) return p.parent.name.getText();
  }
  return "<module>";
}

/** The `if` conditions a node sits in the THEN branch of, innermost first. */
function gatesOf(n: ts.Node): string[] {
  const out: string[] = [];
  for (let c: ts.Node = n, p = n.parent; p; c = p, p = p.parent) {
    if (ts.isIfStatement(p) && p.thenStatement === c) out.push(p.expression.getText());
  }
  return out;
}

interface Site { key: string; arg: string; gates: string[] }

/** Every hand-in (`writeAuthority:`), guard call and no-lease construction in one source. */
function sitesIn(rel: string, text: string): { handIns: Site[]; guards: Site[]; noLease: Site[]; applies: Site[] } {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const r = { handIns: [] as Site[], guards: [] as Site[], noLease: [] as Site[], applies: [] as Site[] };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && n.name.getText() === "writeAuthority") {
      r.handIns.push({ key: `${rel}:${fnOf(n)}`, arg: n.initializer.getText(), gates: gatesOf(n) });
    }
    if (ts.isPropertyAssignment(n) && n.name.getText() === "noLease") {
      r.noLease.push({ key: `${rel}:${fnOf(n)}`, arg: n.initializer.getText(), gates: gatesOf(n) });
    }
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText();
      if (callee === "writeDoorOf" || callee === "assertMayWriteToMailbox") {
        r.guards.push({ key: `${rel}:${fnOf(n)}:${callee}`, arg: n.arguments[0]?.getText() ?? "", gates: gatesOf(n) });
      }
      if (callee === "applyReconcileAction") {
        const deps = n.arguments.find(ts.isObjectLiteralExpression);
        const door = deps?.properties.find((p) => p.name?.getText() === "door");
        r.applies.push({ key: `${rel}:${fnOf(n)}`, arg: door ? door.getText() : "(no door)", gates: [] });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return r;
}

/** WHAT EACH HAND-IN OF AN AUTHORITY IS, by value — exact, one row per spelling. */
const HAND_INS: Record<string, string> = {
  // The cycle's authority, from its own role: a reader, or the permit THIS gate took.
  "apps/sidecar/src/engine.ts:drain": `cycleWriteAuthority(organizing ? "organizer" : "reader", leasePermit)`,
  // A read press's `\Seen` push: always the reader's entitlement, never the organizer's permit.
  "apps/sidecar/src/engine.ts:pushSeen": `cycleWriteAuthority("reader", leasePermit)`,
  "apps/worker/src/index.ts:visitMailbox": "cycleWriteAuthority(rt.role, rt.leasePermit)",
  "apps/worker/src/reconcile-cron.ts:runReconcileCron": "cycleWriteAuthority(deps.role, permit)",
  // The passes inside a cycle ride the cycle's authority (folder ops, the rescue, the sweep port).
  "apps/worker/src/sync.ts:syncCycleWithin": "writeAuthorityOf(deps)",
  "apps/worker/src/index.ts:attach": "hooks.writeAuthority",
  // The operator sweep: a permit under `--execute`; a dry run holds none and asks no write.
  "apps/worker/src/run-junk-sweep.ts:<module>": `{ lease: permit ?? { noLease: "not_supplied" } }`,
  // The operator blank repair: the permit it took under `--apply`; a dry run never reaches the pass.
  "apps/worker/src/run-blank-repair.ts:<module>": "{ lease: permit }",
};

/** EVERY CALL OF THE TWO GUARDS, by what it is handed. A seeded carrier names the gate it sits under. */
const GUARDS: Record<string, { arg: string; gate?: string }> = {
  "apps/worker/src/sync.ts:fileChunk:assertMayWriteToMailbox": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/sync.ts:fileChunk:writeDoorOf": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/sync.ts:fileOne:assertMayWriteToMailbox": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/sync.ts:fileOne:writeDoorOf": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/sync.ts:remakeOwnFolder:assertMayWriteToMailbox": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/sync.ts:remakeOwnFolder:writeDoorOf": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/sync.ts:reconcileFlags:assertMayWriteToMailbox": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/sync.ts:reconcileFlags:writeDoorOf": { arg: "writeAuthorityOf(deps)" },
  "apps/worker/src/folder-ops.ts:runCreate:assertMayWriteToMailbox": { arg: "deps.writeAuthority" },
  "apps/worker/src/folder-ops.ts:runCreate:writeDoorOf": { arg: "deps.writeAuthority" },
  "apps/worker/src/folder-ops.ts:runRename:assertMayWriteToMailbox": { arg: "deps.writeAuthority" },
  "apps/worker/src/folder-ops.ts:runRename:writeDoorOf": { arg: "deps.writeAuthority" },
  "apps/worker/src/folder-ops.ts:runDelete:assertMayWriteToMailbox": { arg: "deps.writeAuthority" },
  "apps/worker/src/folder-ops.ts:runDelete:writeDoorOf": { arg: "deps.writeAuthority" },
  "apps/worker/src/junk-rescue.ts:junkRescuePass:assertMayWriteToMailbox": { arg: "deps.writeAuthority" },
  "apps/worker/src/junk-rescue.ts:junkRescuePass:writeDoorOf": { arg: "deps.writeAuthority" },
  "apps/worker/src/news-fold.ts:newsFoldPass:assertMayWriteToMailbox": { arg: "deps.writeAuthority" },
  "apps/worker/src/news-fold.ts:newsFoldPass:writeDoorOf": { arg: "deps.writeAuthority" },
  "apps/worker/src/junk-sweep.ts:junkSweepPass:assertMayWriteToMailbox": { arg: "writeAuthority" },
  "apps/worker/src/junk-sweep.ts:junkSweepPass:writeDoorOf": { arg: "writeAuthority" },
  "apps/worker/src/blank-repair.ts:blankRepairPass:assertMayWriteToMailbox": { arg: "deps.writeAuthority" },
  "apps/worker/src/blank-repair.ts:blankRepairPass:writeDoorOf": { arg: "deps.writeAuthority" },
  // A permit this function took itself.
  "apps/worker/src/reconcile-cron.ts:runReconcileCron:writeDoorOf": { arg: "{ lease: permit }" },
  "apps/worker/src/run-redacted-restore.ts:<module>:writeDoorOf": { arg: "{ lease: permit }" },
  "apps/worker/src/run-blank-repair.ts:<module>:writeDoorOf": { arg: "{ lease: permit }" },
  // A SEEDED carrier (it starts `not_supplied`), reached only under its gate's organize answer.
  "apps/worker/src/index.ts:attach:writeDoorOf": { arg: "{ lease: leaseState.leasePermit }", gate: `role === "organizer"` },
  "apps/worker/src/index.ts:visitMailbox:writeDoorOf": { arg: "{ lease: rt.leasePermit }", gate: "organize && !wasOrganizer" },
  "apps/sidecar/src/engine.ts:dialAndGate:writeDoorOf": { arg: "{ lease: leasePermit }", gate: "permitted" },
  "apps/sidecar/src/engine.ts:drainPass:writeDoorOf": { arg: "{ lease: leasePermit }", gate: "organizing && !foldersEnsured" },
};

/** EVERY NO-LEASE CONSTRUCTION. `not_supplied` at four defaults, each refused at both guards. */
const NO_LEASE: Record<string, string> = {
  "apps/worker/src/lease.ts:cycleWriteAuthority": `"reader"`,
  "apps/worker/src/index.ts:attach": `"not_supplied"`, // the attach seed, before the gate
  "apps/sidecar/src/engine.ts:attachLocal": `"not_supplied"`, // the local seed, before the gate
  "apps/worker/src/sync.ts:writeAuthorityOf": `"not_supplied"`, // an omitted required field
  "apps/worker/src/run-junk-sweep.ts:<module>": `"not_supplied"`, // the dry run, which asks nothing
};

/** One judgement per site; `""` is admitted. */
function judge(s: ReturnType<typeof sitesIn>): string[] {
  const refused: string[] = [];
  for (const h of s.handIns) if (HAND_INS[h.key] !== h.arg) refused.push(`hand-in ${h.key}: \`${h.arg}\``);
  for (const g of s.guards) {
    const want = GUARDS[g.key];
    if (want === undefined || want.arg !== g.arg) refused.push(`guard ${g.key}: \`${g.arg}\``);
    else if (want.gate !== undefined && !g.gates.some((c) => c === want.gate)) refused.push(`guard ${g.key}: outside \`${want.gate}\``);
  }
  for (const n of s.noLease) if (NO_LEASE[n.key] !== n.arg) refused.push(`noLease ${n.key}: ${n.arg}`);
  for (const a of s.applies) if (a.arg !== "(no door)") refused.push(`applyReconcileAction ${a.key}: ${a.arg}`);
  return refused;
}

/** A `src/` file reaching the fixture door: an import of a test `_door`, or its names. */
function fixtureReachIn(rel: string, text: string): string[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)
      && /(^|\/)(test|__tests__)\/|_door(\.js|\.ts)?$/.test(n.moduleSpecifier.text)) out.push(`${rel}: imports ${n.moduleSpecifier.text}`);
    if (ts.isIdentifier(n) && /^FIXTURE_(LEASE|AUTHORITY|DOOR)$/.test(n.text)) out.push(`${rel}: names ${n.text}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("every production path into an organizer write hands in a lease it took, or a reader's", () => {
  const found = productionSources().map((f) => sitesIn(f.rel, f.text));
  const all = {
    handIns: found.flatMap((s) => s.handIns), guards: found.flatMap((s) => s.guards),
    noLease: found.flatMap((s) => s.noLease), applies: found.flatMap((s) => s.applies),
  };

  it("the census is exact over every `src` — each site judged, and no declared row is dead", () => {
    expect({ refused: judge(all) }).toEqual({ refused: [] });
    const seen = new Set([...all.handIns, ...all.noLease].map((s) => s.key));
    const guardKeys = new Set(all.guards.map((g) => g.key));
    expect({ dead: [...Object.keys(HAND_INS), ...Object.keys(NO_LEASE)].filter((k) => !seen.has(k)) }).toEqual({ dead: [] });
    expect({ dead: Object.keys(GUARDS).filter((k) => !guardKeys.has(k)) }).toEqual({ dead: [] });
    // The services' inline move hands no door, so the adapter refuses it (`no_door`) — three callers.
    expect(all.applies.map((a) => a.key).sort()).toHaveLength(3);
  });

  it("a planted caller with no lease, a seeded carrier outside its gate, or a door handed in reads red", () => {
    const plant = (rel: string, body: string): string[] => judge(sitesIn(rel, body));
    expect(plant("apps/worker/src/planted.ts", `async function p() { await a.ensureFolders(writeDoorOf({ lease: { noLease: "not_supplied" } })); }`))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^guard .*planted/), expect.stringMatching(/^noLease .*planted/)]));
    expect(plant("apps/worker/src/index.ts", `async function visitMailbox() { await rt.adapter.ensureFolders(writeDoorOf({ lease: rt.leasePermit })); }`))
      .toEqual(["guard apps/worker/src/index.ts:visitMailbox:writeDoorOf: outside `organize && !wasOrganizer`"]);
    expect(plant("apps/worker/src/index.ts", `async function visitMailbox() { await runSyncCycle({ writeAuthority: rt.leasePermit }); }`))
      .toEqual(["hand-in apps/worker/src/index.ts:visitMailbox: `rt.leasePermit`"]);
    expect(plant("packages/" + "services/src/planted.ts", `async function p() { await applyReconcileAction(x, { repo, door: someDoor }); }`))
      .toEqual(["applyReconcileAction packages/" + "services/src/planted.ts:p: door: someDoor"]);
    // The admitting control: the same seeded carrier under its gate.
    expect(plant("apps/worker/src/index.ts", `async function visitMailbox() { if (organize && !wasOrganizer) { await rt.adapter.ensureFolders(writeDoorOf({ lease: rt.leasePermit })); } }`))
      .toEqual([]);
  });

  it("the fixture lease is reached by no `src/` file, and a planted import reads red", () => {
    expect(productionSources().flatMap((f) => fixtureReachIn(f.rel, f.text))).toEqual([]);
    expect(fixtureReachIn("apps/worker/src/p.ts", `import { FIXTURE_LEASE } from "../test/_door.js";`))
      .toEqual(["apps/worker/src/p.ts: imports ../test/_door.js", "apps/worker/src/p.ts: names FIXTURE_LEASE"]);
    expect(fixtureReachIn("apps/worker/src/p.ts", `import { writeDoorOf } from "./lease.js";`)).toEqual([]);
  });
});

describe("a write with no lease is refused at both guards, by name", () => {
  const unsupplied: NoOrganizerLease = { noLease: "not_supplied" };

  it("`not_supplied`: the door and the page check refuse every write kind", async () => {
    const door = writeDoorOf({ lease: unsupplied });
    for (const w of ALL) {
      expect(door.ask(w), w).toEqual({ admit: false, reason: "not_supplied" });
      const refused = await assertMayWriteToMailbox({ lease: unsupplied }, w).then(() => null, (e: unknown) => e);
      expect(refused, w).toBeInstanceOf(WriteDeclinedError);
      expect({ write: (refused as WriteDeclinedError).write, reason: (refused as WriteDeclinedError).reason }).toEqual({ write: w, reason: "not_supplied" });
    }
  });

  it("a reader: both guards admit `\\Seen` and refuse every other write alike", async () => {
    const reader: NoOrganizerLease = { noLease: "reader" };
    for (const w of ALL) {
      const want = w === "seen" ? { admit: true } : { admit: false, reason: "no_lease" };
      expect(writeDoorOf({ lease: reader }).ask(w), w).toEqual(want);
      const page = await assertMayWriteToMailbox({ lease: reader }, w).then(() => ({ admit: true }), (e: WriteDeclinedError) => ({ admit: false, reason: e.reason }));
      expect(page, w).toEqual(want);
    }
  });

  it("the fixture lease is admitted by both, as a held claim is", async () => {
    for (const w of ALL) {
      expect(FIXTURE_DOOR.ask(w), w).toEqual({ admit: true });
      await expect(assertMayWriteToMailbox(FIXTURE_AUTHORITY, w)).resolves.toBeUndefined();
    }
  });
});
