import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

/**
 * EVERY TRANSACTION THE AUTH FAMILY OPENS TAKES THE ERASURE FENCE FIRST, or is named here with its
 * reason. A writer that locks a session row and then audits reads the account row second, and the
 * erasure takes that row first: the deadlock that made a deletion fail. The opener's `fence`
 * option makes the account row the first statement; the hosted audit refuses a transaction opened
 * without it, but only where a test happens to drive that body. This census reads every opener in
 * `packages/services/src/auth/*.ts` and `pairing.ts`, keyed `file:enclosing function`, so a new
 * unfenced one is red by name whether or not anything drives it. The allow-list may only shrink.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const AUTH_DIR = "packages/services/src/auth";
const FILES = [
  ...readdirSync(path.join(ROOT, AUTH_DIR)).filter((f) => f.endsWith(".ts")).map((f) => `${AUTH_DIR}/${f}`),
  "packages/services/src/pairing.ts",
];

/** Openers that take no fence, each with the reason it needs none. Keyed by function, counted. */
const UNFENCED: Record<string, { count: number; why: string }> = {
  "session-lifecycle.ts:inTransaction": { count: 1, why: "the delegating wrapper itself; it passes its caller's fence on" },
  "session-lifecycle.ts:rotateRefresh": { count: 1, why: "the hot path: takes no account row and writes no audit" },
  "session-lifecycle.ts:logout": { count: 1, why: "the mass arm, nested inside the hosted logout's fenced transaction" },
};
/* Allowed until the first review, on "writes no audit": each writes a row keyed to the user, which
   is the line that matters, and each failed the erasure from its last steps. A left-over entry is red. */
const REMOVED: Record<string, { count: number; why: string }> = {
  "auth-service.ts:totpEnroll": { count: 1, why: "a pending secret under its own row lock; no audit" },
  "auth-service.ts:generateRecoveryCodes": { count: 1, why: "codes under the user row lock; no audit" },
  "auth-service.ts:authorize": { count: 1, why: "an authorize request under the user row lock; no audit" },
};
/** Register's account is created inside its transaction: no erasure can stamp it before it commits. */
const FENCED_BY_CREATION = "auth-service.ts:register";
/** Raw `.transaction(` calls, outside the opener; the reaper writes no audit and has its own order. */
const RAW: Record<string, string> = {
  "session-reaper.ts:reapStaleWebSessions": "the stale-session reaper: no audit, sessions in id order",
};

interface Site { key: string; line: number }
interface Opener extends Site { fenced: boolean; createsFence: boolean }
interface Census { openers: Opener[]; marks: Site[]; raw: Site[] }

/** The function a node sits in, so a key survives an edit above it. */
function enclosingName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p))
      && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
  }
  return "<module>";
}

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null;

function calls(node: ts.Node, name: string): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && calleeName(n) === name) hit = true;
    if (!hit) ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

function census(file: string, text: string): Census {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const base = path.basename(file);
  const out: Census = { openers: [], marks: [], raw: [] };
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      const site = { key: `${base}:${enclosingName(n)}`, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 };
      if (name === "inTransaction" || name === "runInTransaction") {
        const fenced = n.arguments.some((a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === "fence"));
        out.openers.push({ ...site, fenced, createsFence: n.arguments[1] !== undefined && calls(n.arguments[1], "markFenced") });
      } else if (name === "markFenced") out.marks.push(site);
      else if (name === "transaction" && ts.isPropertyAccessExpression(n.expression)) out.raw.push(site);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function readAll(plant?: { file: string; append: string }): Census {
  const all: Census = { openers: [], marks: [], raw: [] };
  for (const f of FILES) {
    const text = readFileSync(path.join(ROOT, f), "utf8") + (plant?.file === f ? plant.append : "");
    const c = census(f, text);
    all.openers.push(...c.openers); all.marks.push(...c.marks); all.raw.push(...c.raw);
  }
  return all;
}

/** Every finding, named; an empty list is the clean verdict. */
function judge(c: Census, allow = UNFENCED, raw = RAW): string[] {
  const out: string[] = [];
  const unfenced = new Map<string, number>();
  for (const o of c.openers) {
    if (o.fenced) continue;
    if (o.key === FENCED_BY_CREATION && o.createsFence) continue;
    unfenced.set(o.key, (unfenced.get(o.key) ?? 0) + 1);
  }
  for (const [key, n] of unfenced) {
    const entry = allow[key];
    if (entry === undefined) out.push(`UNFENCED ${key}: an opener with no fence and no entry`);
    else if (n > entry.count) out.push(`UNFENCED ${key}: ${n} openers, the entry admits ${entry.count}`);
  }
  for (const key of Object.keys(allow)) if (!unfenced.has(key)) out.push(`STALE ${key}: the entry names no unfenced opener`);
  const marks = c.marks.map((m) => m.key);
  if (marks.length !== 1 || marks[0] !== FENCED_BY_CREATION) out.push(`MARK markFenced outside an opener: ${marks.join(", ") || "none"}`);
  const rawKeys = c.raw.map((r) => r.key);
  for (const k of rawKeys) if (raw[k] === undefined) out.push(`RAW ${k}: a transaction opened past the opener`);
  for (const k of Object.keys(raw)) if (!rawKeys.includes(k)) out.push(`STALE-RAW ${k}`);
  return out;
}

describe("the auth family's transactions open on the erasure fence", () => {
  const tree = readAll();

  it("every opener is fenced, fenced by creation, or named with its reason", () => {
    expect(judge(tree)).toEqual([]);
  });

  it("the counts: every opener fenced but three named (register by creation), one raw", () => {
    const fenced = tree.openers.filter((o) => o.fenced).length;
    const byCreation = tree.openers.filter((o) => !o.fenced && o.key === FENCED_BY_CREATION && o.createsFence).length;
    // 24 -> 25 with `changePassword`: the swap, the revoke, the prune and its audit, fenced.
    // 25 -> 27 with `approveAuthorize` and `mintPairingToken`: each mint's writes and its session hold.
    // 27 -> 31 with `claimDesktopLink`, `token`, `totpVerify` and `webauthnAssertVerify`: each redeem's
    // burn and the session it writes.
    expect({ fenced, byCreation, named: Object.keys(UNFENCED).length, raw: tree.raw.length })
      .toEqual({ fenced: 31, byCreation: 1, named: 3, raw: 1 });
  });

  it("RED: a planted unfenced opener is named", () => {
    const planted = readAll({ file: `${AUTH_DIR}/auth-service.ts`,
      append: "\nasync function plantedDoor(x: any): Promise<void> { await x.inTransaction(x, async () => {}); }\n" });
    expect(judge(planted)).toEqual(["UNFENCED auth-service.ts:plantedDoor: an opener with no fence and no entry"]);
  });

  it("RED: a second unfenced opener in a named function exceeds its entry", () => {
    const planted = readAll({ file: `${AUTH_DIR}/session-lifecycle.ts`,
      append: "\nasync function rotateRefresh(x: any): Promise<void> { await x.inTransaction(x, async () => {}); }\n" });
    expect(judge(planted)).toEqual(["UNFENCED session-lifecycle.ts:rotateRefresh: 2 openers, the entry admits 1"]);
  });

  it("RED: the three entries the first review removed, left over, are each named stale", () => {
    expect(judge(tree, { ...UNFENCED, ...REMOVED })).toEqual([
      "STALE auth-service.ts:totpEnroll: the entry names no unfenced opener",
      "STALE auth-service.ts:generateRecoveryCodes: the entry names no unfenced opener",
      "STALE auth-service.ts:authorize: the entry names no unfenced opener",
    ]);
  });

  it("RED: a stale allow-list entry is named", () => {
    expect(judge(tree, { ...UNFENCED, "auth-service.ts:noSuchDoor": { count: 1, why: "planted" } }))
      .toEqual(["STALE auth-service.ts:noSuchDoor: the entry names no unfenced opener"]);
  });

  it("RED: a brand set outside an opener anywhere but register is named", () => {
    const planted = readAll({ file: "packages/services/src/pairing.ts",
      append: "\nfunction plantedMark(tx: object): void { markFenced(tx, \"x\"); }\n" });
    expect(judge(planted)).toEqual(["MARK markFenced outside an opener: auth-service.ts:register, pairing.ts:plantedMark"]);
  });

  it("RED: a raw transaction past the opener is named", () => {
    const planted = readAll({ file: "packages/services/src/pairing.ts",
      append: "\nasync function plantedRaw(db: any): Promise<void> { await db.transaction(async () => {}); }\n" });
    expect(judge(planted)).toEqual(["RAW pairing.ts:plantedRaw: a transaction opened past the opener"]);
  });
});

/**
 * EVERY OPENER THAT MINTS A GRANT OR VOIDS THEM TAKES THE USER ROW FIRST. A mint holds its session
 * last (`holdLiveSession`), a revoke voids the user's grants (`voidPendingGrants`), and each awaits
 * `lockUserRow` before anything else, so a mint and a revoke of one user wait for each other whole.
 * Postgres shows the waits (`revoke-grants-race.pg.test.ts`) and PGlite, one statement at a time,
 * cannot; this reads every opener, so a mint or a revoke without the lock first is red by name.
 */
const USER_ROW_OPENERS = [
  "auth-service.ts:approveAuthorize", "auth-service.ts:authorize", "auth-service.ts:confirmDesktopApproval",
  "auth-service.ts:issueDesktopLink", "pairing.ts:mintPairingToken", "session-lifecycle.ts:logout",
  "session-lifecycle.ts:revokeClaimedSessions",
];

/** The callee of the first `await` under `node`, in source order; `null` when nothing is awaited. */
function firstAwaited(node: ts.Node): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (found !== null) return;
    if (ts.isAwaitExpression(n)) {
      found = ts.isCallExpression(n.expression) ? (calleeName(n.expression) ?? "?") : "?";
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function userRowFirst(plant?: { file: string; append: string }): { matched: string[]; findings: string[] } {
  const matched: string[] = [];
  const findings: string[] = [];
  for (const f of FILES) {
    const text = readFileSync(path.join(ROOT, f), "utf8") + (plant?.file === f ? plant.append : "");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ["inTransaction", "runInTransaction"].includes(calleeName(n) ?? "")) {
        const body = n.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression =>
          ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        if (body && (calls(body, "holdLiveSession") || calls(body, "voidPendingGrants"))) {
          const key = `${path.basename(f)}:${enclosingName(n)}`;
          matched.push(key);
          const first = firstAwaited(body.body);
          if (first !== "lockUserRow") findings.push(`${key}: awaits ${first} before lockUserRow`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { matched: matched.sort(), findings };
}

describe("every opener that mints or voids a grant takes the user row first", () => {
  it("the seven openers that hold their session last or void grants each await lockUserRow first", () => {
    expect(userRowFirst()).toEqual({ matched: USER_ROW_OPENERS, findings: [] });
  });

  it("RED: a planted mint that holds its session without the lock first is named", () => {
    const planted = userRowFirst({ file: "packages/services/src/pairing.ts", append: "\nasync function plantedMint(ctx: any) {"
      + " return runInTransaction(ctx, async (t: any) => { await writeSomething(t); await holdLiveSession(t, t); }); }\n" });
    expect(planted.findings).toEqual(["pairing.ts:plantedMint: awaits writeSomething before lockUserRow"]);
  });

  it("RED: a planted revoke that voids grants before the lock is named", () => {
    const planted = userRowFirst({ file: `${AUTH_DIR}/session-lifecycle.ts`, append: "\nasync function plantedRevoke(x: any) {"
      + " await x.inTransaction(x, async (t: any) => { await x.voidPendingGrants(t); await lockUserRow(t, \"u\"); }); }\n" });
    expect(planted.findings).toEqual(["session-lifecycle.ts:plantedRevoke: awaits voidPendingGrants before lockUserRow"]);
  });
});
