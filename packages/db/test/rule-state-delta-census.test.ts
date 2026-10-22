import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ═══ EVERY RULE WHOSE STATE MOVES IS ANNOUNCED ══════════════════════════════════════════════
 *
 * `rule` is a synced entity: a client shows the rule it was last told about, and is told only by
 * a `change_log` row. A writer that moves a rule's state without appending one leaves that client
 * showing the old state for ever — nothing looks wrong at the write, and no later read corrects
 * it. Four writers were in exactly that state (the promotion, its re-enable, the lifetime-net
 * demotion, the migration's retarget) while one arm did file, which is what makes this a door
 * rather than a convention.
 *
 * THREE RULES:
 *
 *  1. **Every rule-state write site files a delta.** A site is an `insert`/`delete` on the rules
 *     table, or an `update` whose `.set()` touches a column the client can see. The enclosing
 *     function must call `recordRuleDelta` or build one with `ruleDelta`.
 *  2. **The delta has one shape.** `entityType: "rule"` is composed only inside the door.
 *  3. **The demotion files its own delta**, in its one post-commit door (`demoteRoute`), and
 *     every caller of that door is pinned by name — no caller is left holding ids to file.
 *
 * SCANNED ROOTS are named below. They are scanned as a whole, so this census is invisible to
 * touched-package selection and is run by scanned root.
 */

const HERE = resolve(import.meta.dirname ?? ".");
const REPO = resolve(HERE, "../../..");
const ROOTS = [
  "packages/db/src", "packages/services/src", "packages/api/src", "packages/core/src",
  "apps/worker/src", "apps/sidecar/src",
] as const;

/** The door, and the row-shaped half of it. */
const DOOR = "recordRuleDelta";
const DOOR_SHAPE = "ruleDelta";
/** Where both live — the only module allowed to compose the delta's shape. */
const DOOR_MODULE = "packages/db/src/change-log.ts";

/** Identifiers the rules TABLE is imported under. Both spellings are in the tree. */
const RULES_TABLE = new Set(["rules", "rulesTbl"]);

/**
 * Columns no client can see. `RuleDTO` carries kind, match, destination, priority, provenance,
 * enabled, the two extra terms, the stats and the backlog pass's asked/finished stamps; the walk's
 * cursor and its counter are the organizer's own bookkeeping and ship to nobody. `updatedAt`
 * rides along with whatever moved and is never the whole of a write on its own. `settledPressAt`
 * (mail 0159) is the reader belt's own ordering stamp, written where nothing a client reads moved
 * and on no DTO (`settled-press-stamp-census.test.ts` holds it to that one writer).
 */
const INVISIBLE_COLUMNS = new Set(["retroCursor", "retroMoved", "updatedAt", "settledPressAt"]);

/**
 * Write sites that deliberately file NO delta, each with the reason.
 *
 * A named list rather than a looser rule, because "does this write owe a client anything" is a
 * product read no regex can make. A stale entry is refused below: an exemption that matches
 * nothing is a hole that reads as a decision.
 */
const EXEMPT_WRITE_SITES: Record<string, string> = {
  "packages/services/src/account-deletion-service.ts#deleteAccount":
    "account erasure. The account's whole change_log goes with it, so a delta would name a rule "
    + "for a client that no longer exists.",
  "apps/worker/src/rule-retro.ts#ruleRetroPass":
    "the retro walk's own cursor and counter — `retro_cursor`/`retro_moved`, which are not on "
    + "`RuleDTO`. The mail the walk MOVES is announced as `message` deltas by the same transaction; "
    + "the finished stamp is `stampRetroDone`'s, which files its own.",
  "apps/worker/src/mailboxes.ts#clearOwedRetroFences":
    "`retro_cursor` alone, cleared at a promotion so an owed walk restarts. Not on `RuleDTO`.",
  "apps/sidecar/src/cloud-mirror.ts#applyAccountUpsert":
    "the mirror APPLYING a delta the Cloud already filed. A delta here would announce the "
    + "account's own sync back to it.",
  "apps/sidecar/src/cloud-mirror.ts#applyDelete":
    "the same mirror, applying the delete half.",
};

/**
 * Sites that compose `entityType: "rule"` outside the door, each with the reason. Rule 2's only
 * admitted exception, for the same product reason a regex cannot make.
 */
const EXEMPT_SHAPE_SITES: Record<string, string> = {};

/** Every `demoteRoute(…)` call site: each runs after its own caller's commit, and the door files. */
const DEMOTION_CALLERS: Record<string, string> = {
  "packages/services/src/learning-service.ts#promoteOrDemote":
    "the lifetime demotion, after the approval that fed it committed.",
  "packages/services/src/message-service.ts#switchOffOwedRoute":
    "the in-app move's override, after the move committed (only an erased account's 410 rethrown).",
  "packages/core/src/adapters/drizzle-repo.ts#demoteRoute":
    "the worker's switch-off for an ingest's owed demotion (`runOwedDemotions`), after the ingest committed.",
};

interface Site { file: string; fn: string; line: number }
const key = (s: Site): string => `${s.file}#${s.fn}`;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...tsFiles(p)); continue; }
    if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => tsFiles(join(REPO, r)));

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

/** The nearest named function/method enclosing a node, or `<module>`. */
function enclosingFn(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (
      (ts.isFunctionExpression(n) || ts.isArrowFunction(n))
      && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)
    ) return n.parent.name.text;
  }
  return "<module>";
}

/**
 * The nearest enclosing BLOCK — the scope a delta has to be filed in, and the reason this is not
 * the enclosing FUNCTION.
 *
 * Measured: with the rule at function granularity, deleting the migration retarget's door call
 * left the census GREEN, because the same function's other write files one and `callsName` is
 * satisfied by any call anywhere under it. That is the defect this census exists to refuse —
 * an unfiled write sitting beside a filing one, in one function, was exactly row the second
 * writer. Counting per block, and per block DIRECTLY (a nested block is its own scope), makes
 * each write answer for itself in both directions.
 */
function container(node: ts.Node): ts.Node | undefined {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isCaseClause(n)) return n;
  }
  return undefined;
}

function site(sf: ts.SourceFile, node: ts.Node): Site {
  return {
    file: relative(REPO, sf.fileName),
    fn: enclosingFn(node),
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
  };
}

/** Is `name` CALLED anywhere under `node`? A mention, an import or a type is not a call. */
function callsName(node: ts.Node, name: string): boolean {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const callee = ts.isPropertyAccessExpression(c) ? c.name.text
        : ts.isIdentifier(c) ? c.text
        : null;
      if (callee === name) { found = true; return; }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/**
 * The `.set({ … })` chained onto a rules `update(…)`, when it is written inline.
 *
 * `update(rules).set(x)` where `x` is a variable answers `undefined`, and the caller treats that
 * as state-moving: fail CLOSED. Half of these sites assemble the set object above the statement.
 */
function chainedSet(update: ts.CallExpression): ts.ObjectLiteralExpression | "opaque" | null {
  let n: ts.Node = update;
  for (let hops = 0; hops < 8; hops++) {
    const parent: ts.Node | undefined = n.parent;
    if (!parent || !ts.isPropertyAccessExpression(parent)) return null;
    const call: ts.Node | undefined = parent.parent;
    if (!call || !ts.isCallExpression(call)) return null;
    if (parent.name.text === "set") {
      const arg = call.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) return arg;
      return "opaque";
    }
    n = call;
  }
  return null;
}

/** Property names an object literal assigns, spread included (a spread reads as opaque). */
function setColumns(obj: ts.ObjectLiteralExpression): string[] | "opaque" {
  const names: string[] = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return "opaque";
    if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return "opaque";
    names.push(p.name.text);
  }
  return names;
}

interface WriteSite extends Site { verb: "insert" | "update" | "delete"; visible: boolean }

/** Every write to the rules table in the scanned roots, classified. */
function ruleWrites(): WriteSite[] {
  const out: WriteSite[] = [];
  for (const file of FILES) {
    const sf = parse(file);
    const walk = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && (n.expression.name.text === "insert" || n.expression.name.text === "update"
          || n.expression.name.text === "delete")
        && n.arguments.length === 1 && ts.isIdentifier(n.arguments[0]!)
        && RULES_TABLE.has((n.arguments[0] as ts.Identifier).text)
      ) {
        const verb = n.expression.name.text as WriteSite["verb"];
        let visible = true;
        if (verb === "update") {
          const set = chainedSet(n);
          if (set !== null && set !== "opaque") {
            const cols = setColumns(set);
            // Invisible ONLY when every column written is one no client can see.
            if (cols !== "opaque") visible = cols.some((c) => !INVISIBLE_COLUMNS.has(c));
          }
        }
        out.push({ ...site(sf, n), verb, visible });
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
  }
  return out;
}

/** Every `entityType: "rule"` written as a property initializer. */
function shapeSites(): Site[] {
  const out: Site[] = [];
  for (const file of FILES) {
    const sf = parse(file);
    const walk = (n: ts.Node): void => {
      if (
        ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "entityType"
        && ts.isStringLiteral(n.initializer) && n.initializer.text === "rule"
      ) out.push(site(sf, n));
      // `entityType: "rule" as const` — the same composition with a narrowing cast.
      if (
        ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "entityType"
        && ts.isAsExpression(n.initializer) && ts.isStringLiteral(n.initializer.expression)
        && n.initializer.expression.text === "rule"
      ) out.push(site(sf, n));
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
  }
  return out;
}

/** Every call of `demoteRoute`, by enclosing function. */
function demotionCallSites(): Site[] {
  const out: Site[] = [];
  for (const file of FILES) {
    const sf = parse(file);
    const walk = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
        && n.expression.text === "demoteRoute") out.push(site(sf, n));
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
  }
  return out;
}

const WRITES = ruleWrites();

describe("rule 1 — every rule-state write site files a delta", () => {
  it("finds the write sites at all — a census over nothing cannot fire", () => {
    expect(FILES.length).toBeGreaterThan(300);
    expect(WRITES.length).toBeGreaterThanOrEqual(20);
    // The three verbs are all represented, so a classifier that lost one is visible here.
    expect(new Set(WRITES.map((w) => w.verb))).toEqual(new Set(["insert", "update", "delete"]));
  });

  it("classifies the retro-only updates and the belt's press stamp as invisible, and nothing else", () => {
    // The walk's cursor and counter, and the reader belt's press stamp; the finished stamp is on
    // `RuleDTO` and files a delta.
    expect(WRITES.filter((w) => !w.visible).map(key).sort()).toEqual([
      "apps/worker/src/mailboxes.ts#clearOwedRetroFences",
      "apps/worker/src/rule-retro.ts#ruleRetroPass",
      "packages/db/src/request-apply.ts#settleReaderRuleRows",
    ]);
  });

  it("every client-visible write has a door call in its own block, or is exempt BY NAME", () => {
    const short = new Map<ts.Node, { file: string; writes: Site[]; doors: number }>();
    for (const file of new Set(WRITES.filter((w) => w.visible).map((w) => w.file))) {
      const sf = parse(join(REPO, file));
      const seen = new Map<ts.Node, { file: string; writes: Site[]; doors: number }>();
      const bucket = (n: ts.Node): { file: string; writes: Site[]; doors: number } | undefined => {
        const c = container(n);
        if (c === undefined) return undefined;
        const had = seen.get(c);
        if (had) return had;
        const made = { file, writes: [] as Site[], doors: 0 };
        seen.set(c, made);
        return made;
      };
      const walk = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
          && (n.expression.name.text === "insert" || n.expression.name.text === "update"
            || n.expression.name.text === "delete")
          && n.arguments.length === 1 && ts.isIdentifier(n.arguments[0]!)
          && RULES_TABLE.has((n.arguments[0] as ts.Identifier).text)
        ) {
          const s = site(sf, n);
          const w = WRITES.find((x) => x.file === s.file && x.line === s.line);
          if (w?.visible === true && EXEMPT_WRITE_SITES[key(s)] === undefined) {
            bucket(n)?.writes.push(s);
          }
        }
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
          && (n.expression.text === DOOR || n.expression.text === DOOR_SHAPE)) {
          const b = bucket(n);
          if (b) b.doors += 1;
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
      for (const [node, b] of seen) if (b.writes.length > 0) short.set(node, b);
    }
    // One door per write, in the write's own block. Fewer is a rule that moved and told nobody.
    const unfiled = [...short.values()]
      .filter((b) => b.doors < b.writes.length)
      .flatMap((b) => b.writes);
    expect(unfiled).toEqual([]);
  });

  it("every exemption still matches a write site — a stale one reads as a decision", () => {
    const present = new Set(WRITES.map(key));
    expect(Object.keys(EXEMPT_WRITE_SITES).filter((k) => !present.has(k))).toEqual([]);
  });

  it("the exemption list cannot swallow the rule — most sites DO file", () => {
    const exempt = new Set(Object.keys(EXEMPT_WRITE_SITES));
    const filing = WRITES.filter((w) => w.visible && !exempt.has(key(w)));
    expect(filing.length).toBeGreaterThanOrEqual(15);
  });
});

describe("rule 2 — the delta has one shape", () => {
  const shapes = shapeSites();

  it("finds the composition sites", () => {
    expect(shapes.length).toBeGreaterThanOrEqual(2);
    expect(shapes.some((s) => s.file === DOOR_MODULE)).toBe(true);
  });

  it("`entityType: \"rule\"` is composed in the door and nowhere else unexempted", () => {
    const outside = shapes
      .filter((s) => s.file !== DOOR_MODULE && EXEMPT_SHAPE_SITES[key(s)] === undefined)
      .map(key);
    expect(outside).toEqual([]);
  });

  it("every shape exemption still matches a site", () => {
    const present = new Set(shapes.map(key));
    expect(Object.keys(EXEMPT_SHAPE_SITES).filter((k) => !present.has(k))).toEqual([]);
  });
});

describe("rule 3 — the demotion files its own delta, and its callers are named", () => {
  const callers = demotionCallSites();

  it("is called at exactly the sites that are accounted for", () => {
    expect([...new Set(callers.map(key))].sort()).toEqual(Object.keys(DEMOTION_CALLERS).sort());
  });

  it("the door itself files the delta for the rows it switched off", () => {
    const sf = parse(join(REPO, "packages/db/src/learning-signal.ts"));
    let filed = false;
    const walk = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "demoteRoute") filed = callsName(n, DOOR);
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(sf, walk);
    expect(filed).toBe(true);
  });
});
