import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * ═══ EVERY "APPLIED" IN THE DRAIN IS A CLAIM ABOUT THE WORLD ════════════════════════════════
 *
 * `request-apply.ts` answers a reader's request with `applied: true`, and that word travels back
 * to a person as "your change is in force". One site answered it off a KEY LOOKUP alone: the rule
 * existed, so the request was treated as satisfied — while the destination, the priority and the
 * enabled state the request asked for were never compared and never written.
 *
 * Four rules, each of which fires on the change that would repeat that defect:
 *
 *  1. **Every `find*ByKey` helper is classified**, with the state a request under that key can
 *     ask for. A new helper is a new way to answer "already there" and must be named.
 *  2. **A helper SELECTS every column its comparison reads.** A compared column the select
 *     omits is `undefined` at the comparison, which decides "differs" on every replay and
 *     rewrites the row for ever — the opposite hard stop from the one above.
 *  3. **The compared field list is the request type's own**, minus fields named here as not
 *     state. A field added to the interface reddens until it is classified, so the fix covers
 *     the next field instead of being repeated per field.
 *  4. **Every `applied: true` return site is classified** by what makes the requested state hold
 *     there. A new one must say why, rather than inheriting a neighbour's reason.
 */

const SRC = resolve(import.meta.dirname ?? ".", "../src/request-apply.ts");
const TEXT = readFileSync(SRC, "utf8");
const SF = ts.createSourceFile(SRC, TEXT, ts.ScriptTarget.Latest, true);
/** The key lookup and the converge live one module below (`rule-key.ts`), read with the applier. */
const KEY_SRC = resolve(import.meta.dirname ?? ".", "../src/rule-key.ts");
const KEY_SF = ts.createSourceFile(KEY_SRC, readFileSync(KEY_SRC, "utf8"), ts.ScriptTarget.Latest, true);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/** The `find*ByKey` helpers, and the state a request under that key can ask this file to hold. */
const BY_KEY_LOOKUPS: Readonly<Record<string, {
  /** The request interface the compared field list is DERIVED from. */
  requestType: string;
  /** Members of that interface which are not state. Each says why. */
  notState: Readonly<Record<string, string>>;
  /** The source's own derived field table, whose keys these three must agree with. */
  stateTable: string;
  /** What the drain compares and applies. Equal to the interface minus `notState`. */
  compares: readonly string[];
}>> = {
  findRulesByKey: {
    requestType: "ValidatedRuleCreate",
    stateTable: "RULE_CREATE_STATE",
    notState: {
      op: "which verb the record carries, not a column",
      key: "WHICH rule — the four fields this helper matches on",
      applyRetro: "what to do with mail already filed, not a property of the rule",
    },
    compares: ["destination", "priority", "enabled"],
  },
};

/** Every `applied: true` answer, by the function that gives it, with what makes the state hold. */
const APPLIED_SITES: Readonly<Record<string, { ops: readonly string[]; why: string }>> = {
  applyMessageMove: {
    ops: ["-"],
    why: "the desired-state upsert is unconditional — a move to where the message already is "
      + "still writes, so the row names the request's destination at every return",
  },
  applyRuleRequest: {
    ops: ["create", "unchanged", "update", "delete", "update"],
    why: "create-on-nothing inserts the requested row; delete removes it; update writes every "
      + "field the request's `set` named — and create-on-an-existing-key applies ruleCreateDiff "
      + "(`reconcileRuleCreate`) and answers `update` too, because that is what it did: the row was "
      + "already there, the difference was written into it and the delta it records is an update. "
      + "It answered `create`, the word the REQUEST used, until RECONCILED-CREATE-STILL-ANSWERS-THE-"
      + "WORD-CREATE. `unchanged` is a create whose key already held every requested field: the "
      + "state holds by the diff being empty, so nothing is written and no delta is recorded",
  },
};

function enclosingFunctionName(node: ts.Node): string | null {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p)) return p.name?.text ?? null;
  }
  return null;
}

describe("request-apply.ts — the by-key census", () => {
  it("1. every find*ByKey helper is classified", () => {
    const found: string[] = [];
    for (const sf of [SF, KEY_SF]) {
      walk(sf, (n) => {
        if (ts.isFunctionDeclaration(n) && n.name && /^find.*ByKey$/.test(n.name.text)) found.push(n.name.text);
      });
    }
    expect(found.length).toBeGreaterThan(0);          // a census that selects nothing covers nothing
    expect(found.sort()).toEqual(Object.keys(BY_KEY_LOOKUPS).sort());
  });

  it("2. each helper selects every column its comparison reads", () => {
    for (const [name, spec] of Object.entries(BY_KEY_LOOKUPS)) {
      let decl: ts.FunctionDeclaration | null = null;
      for (const sf of [SF, KEY_SF]) {
        walk(sf, (n) => {
          if (ts.isFunctionDeclaration(n) && n.name?.text === name) decl = n;
        });
      }
      expect(decl, `${name} not found`).not.toBeNull();

      const selected = new Set<string>();
      walk(decl!, (n) => {
        if (!ts.isCallExpression(n)) return;
        const callee = n.expression;
        if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "select") return;
        const arg = n.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) return;
        for (const p of arg.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) selected.add(p.name.text);
        }
      });
      expect(selected.size, `${name} selects nothing`).toBeGreaterThan(0);
      for (const column of spec.compares) {
        expect([...selected], `${name} compares ${column} without reading it`).toContain(column);
      }
    }
  });

  it("3. the compared field list is the request type's own, minus the fields named as not state", () => {
    for (const [name, spec] of Object.entries(BY_KEY_LOOKUPS)) {
      let members: string[] | null = null;
      let table: string[] | null = null;
      walk(SF, (n) => {
        if (ts.isInterfaceDeclaration(n) && n.name.text === spec.requestType) {
          members = n.members.flatMap((m) =>
            ts.isPropertySignature(m) && ts.isIdentifier(m.name) ? [m.name.text] : []);
        }
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === spec.stateTable
          && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
          table = n.initializer.properties.flatMap((pr) =>
            ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.name) ? [pr.name.text] : []);
        }
      });
      expect(members, `${spec.requestType} not found`).not.toBeNull();
      expect(table, `${spec.stateTable} not found`).not.toBeNull();

      /* THREE READINGS OF ONE LIST, CHAINED. The interface is the request; the source's table is
         what the drain compares; the pin is what this census was written against. Narrowing any
         one of them alone reddens here — which is the shape the defect had. */
      const state = members!.filter((m) => !(m in spec.notState));
      expect(state.sort(), `${name}: the interface moved and the comparison did not`)
        .toEqual([...spec.compares].sort());
      expect([...table!].sort(), `${spec.stateTable} no longer covers the request's state`)
        .toEqual([...spec.compares].sort());
      // A stale exemption is refused too: a field named as not-state must still be on the type.
      for (const exempt of Object.keys(spec.notState)) {
        expect(members!, `${spec.requestType} no longer has ${exempt}`).toContain(exempt);
      }
    }
  });

  it("4. every `applied: true` return site is classified by what makes the state hold", () => {
    const sites = new Map<string, string[]>();
    walk(SF, (n) => {
      if (!ts.isReturnStatement(n) || !n.expression) return;
      const obj = n.expression;
      if (!ts.isObjectLiteralExpression(obj)) return;
      const applied = obj.properties.find((p) =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "applied");
      if (!applied || !ts.isPropertyAssignment(applied)) return;
      if (applied.initializer.kind !== ts.SyntaxKind.TrueKeyword) return;

      const fn = enclosingFunctionName(n) ?? "<top level>";
      const op = obj.properties.find((p) =>
        ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "op");
      const word = op && ts.isPropertyAssignment(op) && ts.isStringLiteral(op.initializer)
        ? op.initializer.text : "-";
      sites.set(fn, [...(sites.get(fn) ?? []), word]);
    });

    expect(sites.size, "no applied sites found — the census selects nothing").toBeGreaterThan(0);
    expect([...sites.keys()].sort()).toEqual(Object.keys(APPLIED_SITES).sort());
    for (const [fn, ops] of sites) {
      expect([...ops].sort(), `${fn}: an unclassified applied answer`)
        .toEqual([...APPLIED_SITES[fn]!.ops].sort());
    }
  });

  it("6. the belt takes the account's rule-key lock before it reads a press's legs", () => {
    // Under READ COMMITTED, a leg read before the lock can miss the other final leg's settle and
    // leave a finished press unsettled for good. CODE order, read off the parse, never a comment.
    let belt: ts.FunctionDeclaration | null = null;
    walk(SF, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === "settleReaderRuleRows") belt = n; });
    expect(belt, "settleReaderRuleRows is gone").not.toBeNull();
    const at: Record<string, number[]> = { advisoryLock: [], listPressLegs: [] };
    walk(belt!, (n) => {
      if (!ts.isCallExpression(n)) return;
      const name = ts.isIdentifier(n.expression) ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
      if (name in at) at[name]!.push(n.getStart(SF));
    });
    expect(at.advisoryLock!.length, "the belt takes no rule-key lock").toBeGreaterThan(0);
    expect(at.listPressLegs!.length, "the belt reads no legs").toBeGreaterThan(0);
    expect(Math.min(...at.advisoryLock!), "the legs are read before the lock").toBeLessThan(Math.min(...at.listPressLegs!));
  });

  it("5. the create branch reconciles before it acks an existing row", () => {
    let create: ts.IfStatement | null = null;
    walk(SF, (n) => {
      if (ts.isIfStatement(n) && ts.isIdentifier(n.expression) && n.expression.text === "existing") create = n;
    });
    expect(create, "the `if (existing)` branch is gone").not.toBeNull();

    const calls: string[] = [];
    let updatesRules = false;
    walk(create!, (n) => {
      if (!ts.isCallExpression(n)) return;
      if (ts.isIdentifier(n.expression)) calls.push(n.expression.text);
      if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "update") {
        const arg = n.arguments[0];
        if (arg && ts.isIdentifier(arg) && arg.text === "rulesTbl") updatesRules = true;
      }
    });
    expect(calls, "the ack no longer compares the row against the request").toContain("ruleCreateDiff");
    expect(updatesRules, "the difference is computed and never written").toBe(true);
  });
});

/**
 * THE RULE-KEY LOCK COMES FIRST IN EVERY RULES WRITER: before the first statement on `rules` and
 * before any mailbox lock a held bag takes. CODE order off the parse, never a comment needle.
 */
const ROOT = resolve(import.meta.dirname ?? ".", "../../..");

function fnIn(file: string, name: string): { sf: ts.SourceFile; fn: ts.Node } {
  const sf = ts.createSourceFile(file, readFileSync(resolve(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
  let fn: ts.Node | null = null;
  walk(sf, (n) => {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name) fn = n;
  });
  expect(fn, `${file}: ${name} is gone`).not.toBeNull();
  return { sf, fn: fn! };
}

/** Offsets of calls by name, and of every expression naming the rules table. */
function positions(sf: ts.SourceFile, fn: ts.Node, calls: readonly string[]): { calls: Record<string, number[]>; rules: number[] } {
  const at: Record<string, number[]> = Object.fromEntries(calls.map((c) => [c, []]));
  const rules: number[] = [];
  walk(fn, (n) => {
    if (ts.isCallExpression(n)) {
      const name = ts.isIdentifier(n.expression) ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
      if (name in at) at[name]!.push(n.getStart(sf));
      for (const a of n.arguments) if (ts.isIdentifier(a) && (a.text === "rules" || a.text === "rulesTbl")) rules.push(a.getStart(sf));
    }
  });
  return { calls: at, rules };
}

describe("every rules writer takes the rule-key lock first", () => {
  const LOCK = "lockAccountRuleKeys";
  const cases: ReadonlyArray<{ file: string; fn: string; after: readonly string[] }> = [
    { file: "packages/db/src/screener-apply.ts", fn: "applyScreenerDecision", after: ["writeRuleUnderKey", "heldRowsForSender", "heldRowsForDomain", "rerouteHeldBag"] },
    { file: "packages/services/src/held-release-service.ts", fn: "releaseHeld", after: ["heldReleaseGroups", "applyScreenerDecision"] },
    { file: "packages/api/src/junk-window.ts", fn: "allowSender", after: ["writeRuleUnderKey"] },
    { file: "packages/services/src/rules-service.ts", fn: "update", after: ["convergeRuleKey", "planAccountFanOut"] },
    { file: "packages/services/src/rules-service.ts", fn: "remove", after: ["planAccountFanOut"] },
    // The profile import writes contacts and rules: the lock comes before its own lock and both.
    { file: "packages/core/src/adapters/organizer-profile-store.ts", fn: "applyOrganizerProfile", after: ["advisoryLock", "insert"] },
  ];
  for (const c of cases) {
    it(`${c.fn} (${c.file}) locks before its first rules statement and every later step`, () => {
      const { sf, fn } = fnIn(c.file, c.fn);
      const p = positions(sf, fn, [LOCK, ...c.after]);
      expect(p.calls[LOCK]!.length, `${c.fn} takes no rule-key lock`).toBeGreaterThan(0);
      const lock = Math.min(...p.calls[LOCK]!);
      const later = [...p.rules, ...c.after.flatMap((a) => p.calls[a]!)];
      expect(later.length, `${c.fn}: the census found nothing to order`).toBeGreaterThan(0);
      expect(later.filter((x) => x < lock), `${c.fn}: a rules statement or a later step comes before the lock`).toEqual([]);
    });
  }

  it("the rule doors open through withAccountTx: the fence is the first statement, before the lock", () => {
    for (const name of ["update", "remove"]) {
      const { sf, fn } = fnIn("packages/services/src/rules-service.ts", name);
      const p = positions(sf, fn, ["withAccountTx", "transaction", LOCK]);
      expect(p.calls.withAccountTx!.length, `${name} no longer opens through withAccountTx`).toBe(1);
      expect(p.calls.transaction!, `${name} opens a transaction of its own`).toEqual([]);
      expect(p.calls.withAccountTx![0]!).toBeLessThan(Math.min(...p.calls[LOCK]!));
    }
  });
});

/**
 * THE ORDER IS READ FROM THE OUTERMOST TRANSACTION, not the helper (H2): a
 * fence opened with a `mailboxId` holds the mailbox row before the body runs, so a helper whose own
 * body locks first still runs after a mailbox lock. Each opener of a rules-writing transaction
 * (one whose body takes the rule-key lock, or calls a writer that takes it first) opens without
 * the mailbox arm, and inside it that lock precedes every mailbox-arm call. A function with no
 * such opener is refused by name: the list names rules writers.
 */
const OPENER_CALLS = new Set(["withAccountTx", "fencedAccountWrite", "transaction"]);
const LOCKS = new Set([
  "lockAccountRuleKeys", "allowSender", "applyScreenerDecision", "writeRuleUnderKey", "convergeRuleKey", "applyOrganizerProfile",
  // Writes no rule, but takes the rule-key lock before the bag's mailbox locks, as the decision does.
  "rerouteUnconfirmedHeld",
]);
const MAILBOX_ARM = new Set(["fenceErasedMailbox", "readMailboxErasedAt", "readOrganizerRole", "assertOrganizerRole"]);

/** The violations of one opener's source, by name; the planted controls below drive it too. */
function openerOrder(sf: ts.SourceFile, fn: ts.Node): string[] {
  const out: string[] = [];
  const name = (n: ts.CallExpression): string => ts.isIdentifier(n.expression) ? n.expression.text
    : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
  const hasMailboxProp = (o: ts.Expression): boolean => ts.isObjectLiteralExpression(o)
    && o.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "mailboxId");
  let opened = 0;
  walk(fn, (n) => {
    if (!ts.isCallExpression(n) || !OPENER_CALLS.has(name(n))) return;
    const body = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (!body) return;
    let lock = Infinity;
    const arms: number[] = [];
    walk(body, (c) => {
      if (!ts.isCallExpression(c)) return;
      const k = name(c);
      if (LOCKS.has(k)) lock = Math.min(lock, c.getStart(sf));
      if (MAILBOX_ARM.has(k) || (k === "fenceErased" && c.arguments.some(hasMailboxProp))) arms.push(c.getStart(sf));
    });
    if (lock === Infinity) return; // writes no rules: not this census's transaction
    opened++;
    if (n.arguments.some(hasMailboxProp)) out.push("the transaction opens with the mailbox arm (mailboxId) before its body locks");
    for (const at of arms) if (at < lock) out.push(`a mailbox-arm call at offset ${at} comes before the rule-key lock`);
  });
  if (opened === 0) out.push("no rules-writing transaction found");
  return out;
}

describe("the rule-key lock precedes every mailbox lock, read from the outermost transaction", () => {
  const OPENERS: ReadonlyArray<{ file: string; fn: string }> = [
    { file: "packages/api/src/junk-window.ts", fn: "rescueJunk" },
    { file: "packages/services/src/rules-service.ts", fn: "update" },
    { file: "packages/services/src/rules-service.ts", fn: "remove" },
    { file: "packages/services/src/held-release-service.ts", fn: "releaseHeld" },
    { file: "packages/services/src/hey-migration.ts", fn: "migrateFromObservations" },
    { file: "packages/services/src/screener-service.ts", fn: "applyAsOrganizer" },
    { file: "apps/worker/src/screener-auto-act.ts", fn: "screenerAutoActPass" },
    { file: "apps/worker/src/profile.ts", fn: "answerImportAsk" },
    { file: "packages/services/src/profile-import-service.ts", fn: "apply" },
  ];
  for (const o of OPENERS) {
    it(`${o.fn} (${o.file})`, () => {
      const { sf, fn } = fnIn(o.file, o.fn);
      expect(openerOrder(sf, fn)).toEqual([]);
    });
  }

  it("the planted shapes are refused: a mailbox-armed opener, and a mailbox fence before the lock", () => {
    const parse = (src: string) => {
      const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
      let fn: ts.Node | null = null;
      walk(sf, (n) => { if (ts.isFunctionDeclaration(n)) fn = n; });
      return openerOrder(sf, fn!);
    };
    expect(parse("async function f(ctx, id) { return withAccountTx(ctx, async (tx) => { await allowSender(tx); }, { db, mailboxId: id }); }"))
      .toEqual(["the transaction opens with the mailbox arm (mailboxId) before its body locks"]);
    expect(parse("async function f(ctx, id) { return withAccountTx(ctx, async (tx) => { await fenceErased(tx, d, { accountId, mailboxId: id }); await lockAccountRuleKeys(tx, a); }); }"))
      .toHaveLength(1);
    // The admitted shape: account fence at the opener, the lock, then the mailbox arm.
    expect(parse("async function f(ctx, id) { return withAccountTx(ctx, async (tx) => { await lockAccountRuleKeys(tx, a); await fenceErased(tx, d, { accountId, mailboxId: id }); }, { db }); }"))
      .toEqual([]);
  });
});

