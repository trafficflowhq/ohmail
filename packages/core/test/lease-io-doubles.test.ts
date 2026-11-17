import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ═══ EVERY LEASE DOUBLE NAMES A FOLDER GENERATION, BECAUSE THE PRODUCT'S ONE IO ALWAYS DOES ═══
 *
 * `LEASE-DOUBLES-OMIT-THE-FOLDER-GENERATION`. The product ships exactly one `LeaseIo` —
 * `makeLeaseIo` — and it always implements `uidValidity()`; a `null` from it means the SERVER did
 * not report UIDVALIDITY on SELECT. Twenty-nine doubles in the test tree left the accessor out, so
 * they drove the gate in a state no install reaches — and since 2026-09-12 that state is the one
 * the takeover's confirm REFUSES on, which is how four of them went red the day the door landed.
 *
 * The rule is the one this repo states everywhere: a double fails the way production fails, with
 * the same shape and the same partial state. A capability production always has is not a detail a
 * fixture may drop; dropping it is the lenient double wearing a defect's clothes.
 *
 * WHAT THE CENSUS ASKS, and why it is not "does the file say `implements LeaseIo`": the shape is
 * structural. A hand-written `type LeaseIoShape` and a bare object literal handed to `leaseIo()`
 * are both lease doubles and neither names the interface. So the domain is BY MEMBERS — any class,
 * object literal, interface or type literal in the test tree that presents all four of the lease's
 * required operations — and every member of it must declare `uidValidity` too.
 *
 * WHAT IT DOES NOT CLAIM. A double assembled at runtime (spread from a factory, built by a Proxy)
 * presents no literal to parse and is out of its domain. It proves that every shape an author can
 * read as a lease io HAS been read as one.
 *
 * Scanned by ROOT — three test trees in three packages — so a touched-package selection never
 * decides whether it runs.
 */

const ROOTS = ["packages/core/test", "apps/worker/test", "packages/organizer/test", "apps/sidecar/test"];
const REPO = resolve(__dirname, "../../..");

/** The lease's required operations. A shape presenting all four IS a lease io, named or not. */
const REQUIRED = ["ensureMetaFolder", "listClaims", "appendClaim", "removeClaims"] as const;

/** The accessor every one of them owes, because `makeLeaseIo` always has it. */
const GENERATION = "uidValidity";

interface Double { at: string; names: boolean }

function memberName(m: ts.NamedDeclaration | ts.ObjectLiteralElementLike): string | null {
  const n = (m as { name?: ts.Node }).name;
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n)) return n.text;
  return null;
}

/** Every lease-shaped declaration in one source, by `path:line`. */
function doublesIn(fileName: string, text: string): Double[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: Double[] = [];
  const visit = (n: ts.Node): void => {
    let members: ReadonlyArray<ts.NamedDeclaration | ts.ObjectLiteralElementLike> | null = null;
    if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) members = n.members;
    else if (ts.isObjectLiteralExpression(n)) members = n.properties;
    else if (ts.isTypeLiteralNode(n) || ts.isInterfaceDeclaration(n)) members = n.members;
    if (members) {
      const names = new Set(members.map(memberName).filter((s): s is string => s !== null));
      if (REQUIRED.every((r) => names.has(r))) {
        const line = src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
        out.push({ at: `${fileName}:${line}`, names: names.has(GENERATION) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

function doublesUnder(root: string): Double[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(resolve(REPO, root));
  return files.flatMap((f) => doublesIn(
    relative(REPO, f).replace(/\\/g, "/"), readFileSync(f, "utf8"),
  ));
}

/**
 * THE RELEASE'S READ NEVER ANSWERS `null` IN A DOUBLE, BECAUSE `makeLeaseIo`'S NEVER DOES.
 *
 * `FIX-CLAIM-LEASEIO-DOUBLES-NOT-PRODUCTION-SHAPED`. The product's one io refuses a read it could
 * not complete with a `ClaimReleaseError` (`unreadable`, `over_ceiling`); three sidecar doubles
 * answered `null` instead, which drives `releaseMailboxClaim` down a `search_refused` arm only a
 * double reaches. The premise is read from the source too, so the rule dies loudly with it.
 */
const RELEASE_READ = "findOwnRecords";
const PRODUCT_IO = "packages/core/src/adapters/organizer-lease.ts";

function returnsNull(fn: ts.FunctionLikeDeclaration): boolean {
  const isNull = (e: ts.Expression | undefined): boolean => {
    if (!e) return false;
    let x = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x)) x = x.expression;
    if (x.kind === ts.SyntaxKind.NullKeyword) return true;
    return ts.isConditionalExpression(x) && (isNull(x.whenTrue) || isNull(x.whenFalse));
  };
  const body = fn.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return isNull(body);
  let hit = false;
  const visit = (n: ts.Node): void => {
    if (n !== body && ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && isNull(n.expression)) hit = true;
    ts.forEachChild(n, visit);
  };
  visit(body);
  return hit;
}

interface ReleaseRead { at: string; null: boolean; file: string; within: string | null }

/**
 * The one case allowed a `null` read: the unit test of `releaseMailboxClaim`'s own refusal of it,
 * which the interface still admits. Keyed on the case's title, and each entry must still exist.
 */
const NULL_ARM_CASES = [{
  file: "apps/worker/test/organizer-lease-worker.test.ts",
  within: "a refused own-record search is reported, not quietly downgraded to a partial release",
}];

/** The title of the nearest enclosing `it("…", …)`, or `null`. */
function enclosingCase(n: ts.Node): string | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === "it") {
      const first = p.arguments[0];
      if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) return first.text;
    }
  }
  return null;
}

/** Every `findOwnRecords` in one source, by `path:line`, with whether it can answer `null`. */
function releaseReadsIn(fileName: string, text: string): ReleaseRead[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: ReleaseRead[] = [];
  const visit = (n: ts.Node): void => {
    let fn: ts.FunctionLikeDeclaration | null = null;
    if (ts.isMethodDeclaration(n) && memberName(n) === RELEASE_READ) fn = n;
    else if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && memberName(n) === RELEASE_READ
      && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      fn = n.initializer;
    }
    if (fn) {
      const line = src.getLineAndCharacterOfPosition(n.getStart(src)).line + 1;
      out.push({ at: `${fileName}:${line}`, null: returnsNull(fn), file: fileName, within: enclosingCase(n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

function releaseReadsUnder(root: string): ReleaseRead[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(resolve(REPO, root));
  return files.flatMap((f) => releaseReadsIn(
    relative(REPO, f).replace(/\\/g, "/"), readFileSync(f, "utf8"),
  ));
}

describe("the lease-double census over three test roots", () => {
  it("the census reaches all three roots — a scanner that found nothing proves nothing", () => {
    for (const root of ROOTS) expect(doublesUnder(root).length, root).toBeGreaterThan(0);
  });

  it("every lease double in the test tree names a folder generation", () => {
    const silent = ROOTS.flatMap(doublesUnder).filter((d) => !d.names).map((d) => d.at).sort();
    expect(
      silent,
      "a lease double with no `uidValidity()` drives the takeover's confirm in a state no install "
      + "reaches — give it one, settable where a case needs the refusal",
    ).toEqual([]);
  });

  it("the product's release read refuses rather than answering null — the premise, read", () => {
    const product = releaseReadsIn(PRODUCT_IO, readFileSync(resolve(REPO, PRODUCT_IO), "utf8"));
    expect(product.length, "the product io's release read was not found; the census reads nothing")
      .toBeGreaterThan(0);
    expect(product.filter((r) => r.null).map((r) => r.at),
      "the product io now answers null, so the doubles' rule below has lost its premise")
      .toEqual([]);
  });

  it("no lease double's release read answers null — it refuses the way the product io does", () => {
    const reads = ROOTS.flatMap(releaseReadsUnder);
    expect(reads.length, "no double's release read was found; the census reads nothing").toBeGreaterThan(0);
    const armCase = (r: ReleaseRead): boolean =>
      NULL_ARM_CASES.some((c) => c.file === r.file && c.within === r.within);
    expect(reads.filter((r) => r.null && !armCase(r)).map((r) => r.at).sort(),
      "throw what the product io throws instead (apps/sidecar/test/_release-refusal.ts)")
      .toEqual([]);
    for (const c of NULL_ARM_CASES) {
      expect(reads.some((r) => r.null && armCase(r) && r.file === c.file),
        `${c.file} > "${c.within}" no longer answers null; drop it from NULL_ARM_CASES`).toBe(true);
    }
  });
});

/**
 * The census's own arms, driven by fixtures rather than by editing a real double: a shape that
 * omits the accessor is REPORTED, the same shape with it is ADMITTED, and a read-only peek io —
 * three of the four operations — is out of the domain rather than silently owed one.
 */
describe("the census's own refusal and its positive control", () => {
  const lease = (extra: string): string => `
    class Fixture {
      async ensureMetaFolder(): Promise<void> {}
      async listClaims(): Promise<never[]> { return []; }
      async appendClaim(): Promise<void> {}
      async removeClaims(): Promise<void> {}${extra}
    }
  `;

  it("REFUSES a double that omits the accessor, naming file and line", () => {
    const found = doublesIn("fixture.ts", lease(""));
    expect(found.map((d) => d.at)).toEqual(["fixture.ts:2"]);
    expect(found[0]!.names).toBe(false);
  });

  it("ADMITS the same double once it names one", () => {
    const found = doublesIn("fixture.ts", lease(`
      uidValidity(): number | bigint | null { return 4_100; }`));
    expect(found).toHaveLength(1);
    expect(found[0]!.names).toBe(true);
  });

  it("ADMITS an object literal and a hand-written type, which name no interface at all", () => {
    const text = `
      type Shape = {
        ensureMetaFolder(): Promise<void>;
        listClaims(): Promise<never[]>;
        appendClaim(): Promise<void>;
        removeClaims(): Promise<void>;
        uidValidity(): number | null;
      };
      const io = {
        ensureMetaFolder: async () => {},
        listClaims: async () => [],
        appendClaim: async () => {},
        removeClaims: async () => {},
        uidValidity: () => 4_100,
      };
    `;
    const found = doublesIn("fixture.ts", text);
    expect(found).toHaveLength(2);
    expect(found.every((d) => d.names)).toBe(true);
  });

  it("REFUSES a release read that answers null, and ADMITS one that throws", () => {
    const text = `
      class A { async findOwnRecords() { if (x) return null; return []; } }
      const b = { findOwnRecords: async () => (y ? null : []) };
      class C { async findOwnRecords() { if (x) throw new Error("refused"); return [1].map(() => null); } }
    `;
    expect(releaseReadsIn("fixture.ts", text).map((r) => [r.at, r.null])).toEqual([
      ["fixture.ts:2", true], ["fixture.ts:3", true], ["fixture.ts:4", false],
    ]);
  });

  it("is NOT satisfied by three of the four operations — a peek io owes no generation", () => {
    const text = `
      const peek = {
        listClaims: async () => [],
        appendClaim: async () => {},
        removeClaims: async () => {},
      };
    `;
    expect(doublesIn("fixture.ts", text)).toEqual([]);
  });
});
