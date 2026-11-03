import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * ONE OWN-ADDRESS SET FOR THE ROUTER (VERIFY-026 HIGH). Every call of `evaluateRules` hands it an
 * `ownAddresses` read through `readOwnAddresses` (the repo's `ownAddresses` door is that read), or a
 * parameter every feeder of which does; and no module builds a second own set from mailbox rows
 * except those named in WIDER with their reason — the thread shields among them, which keep every
 * address the person has written from. Parsed for the CALL by TypeScript's parser, over source whose
 * comments `withoutComments` blanked. A planted caller that builds its own set reads red, and a
 * stale entry in either table is refused.
 */
const ROOT = resolve(import.meta.dirname ?? ".", "../../..");
const ROOTS = ["apps/sidecar/src", "apps/worker/src", "packages/api/src", "packages/core/src", "packages/db/src", "packages/services/src"];
const ONE_SET_HOME = "packages/db/src/own-mail.ts";

const WE_ANSWERED = "the we-answered shield: a reply the person sent from a mailbox they later removed is still their reply";
const CONTACT_ONLY = "the contact-only held shield: a reply in the thread from a mailbox the person later removed is still theirs";

/** Builders of a wider own set, by `file#function`, each with why it is wider on purpose. */
const WIDER: Readonly<Record<string, string>> = {
  "apps/worker/src/rule-retro.ts#ruleRetroPass": WE_ANSWERED,
  "apps/worker/src/gap-catchup.ts#gapCatchupPass": WE_ANSWERED,
  "apps/worker/src/ohbox-tidy.ts#ohboxTidyPass": WE_ANSWERED,
  "packages/services/src/sensitive-rescreen.ts#runSensitiveRescreen": WE_ANSWERED,
  "packages/core/src/unscreened-set.ts#unscreenedWalk":
    `${WE_ANSWERED}; its not-from-myself filter keeps the same list, so the offer and the agree's sweep stay a subset of what the gate screens`,
  "apps/worker/src/gate-release.ts#gateReleasePass": CONTACT_ONLY,
  "packages/services/src/held-release-service.ts#heldReleaseSenders": CONTACT_ONLY,
  "packages/services/src/why-stayed-service.ts#whyStayed":
    "the why-stayed sheet names the we-answered shield's facts, so it reads the shield's set",
  "apps/worker/src/thread-join-heal.ts#threadJoinHealPass":
    "threading: every address the account ever synced under is self, so an old address witnesses nothing",
  "packages/services/src/away-responder-pass.ts#answerForAccount":
    "the away responder never answers a former address of its owner: that is the same loop as its current one",
  "packages/services/src/consent-seed.ts#buildSeedReview":
    "the Sent-mail seed reads what the person wrote from every address they wrote it from",
  "packages/services/src/consent-seed.ts#confirmSeed":
    "the seed's confirm keeps the connect-time pass's contact rows for every address the person wrote from",
};

/** A parameter property fed from another file, by `file#function:expression`, and the feeder that reads it. */
const FED_ACROSS: Readonly<Record<string, { file: string; fn: string }>> = {
  "packages/core/src/pipeline.ts#planFromRaw:deps.ownAddresses": { file: "apps/worker/src/sync.ts", fn: "ownAddressesFor" },
};

type Verdict = { kind: "fed" | "built" | "unknown"; why: string; across?: string };

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(resolve(ROOT, rel), { withFileTypes: true })) {
      const p = join(rel, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const r of ROOTS) walk(r);
  return out.sort();
}

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, withoutComments(text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function fnName(n: ts.Node): string {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)) return p.name.text;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer
      && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.text;
  }
  return "<top level>";
}

const isFn = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
  || ts.isArrowFunction(n) || ts.isFunctionExpression(n);

/** Does `n` contain a call that reads the one set: `readOwnAddresses(…)` or a `.ownAddresses(…)` door? */
function readsTheOneSet(n: ts.Node): boolean {
  let hit = false;
  const visit = (x: ts.Node) => {
    if (hit) return;
    if (ts.isCallExpression(x)) {
      const c = x.expression;
      if ((ts.isIdentifier(c) && c.text === "readOwnAddresses")
        || (ts.isPropertyAccessExpression(c) && c.name.text === "ownAddresses")) { hit = true; return; }
    }
    ts.forEachChild(x, visit);
  };
  visit(n);
  return hit;
}

/** Does `n` select `mailboxes.address` from `mailboxes` — an own set built from the rows? */
function buildsFromMailboxRows(n: ts.Node): boolean {
  let from = false;
  let address = false;
  const visit = (x: ts.Node) => {
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "from"
      && x.arguments.some((a) => ts.isIdentifier(a) && a.text === "mailboxes")) from = true;
    if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "mailboxes"
      && x.name.text === "address") address = true;
    ts.forEachChild(x, visit);
  };
  visit(n);
  return from && address;
}

/** The binding `name` refers to at `at`: a variable declaration before it, or an enclosing function's parameter. */
function bindingOf(name: string, at: ts.Node): { decl?: ts.VariableDeclaration; param?: { fn: ts.FunctionLikeDeclaration; index: number; prop?: string } } {
  for (let p: ts.Node | undefined = at.parent; p; p = p.parent) {
    if (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p)) {
      for (const st of p.statements) {
        if (st.pos > at.pos) break;
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return { decl: d };
      }
    }
    if (isFn(p)) {
      for (const [index, prm] of p.parameters.entries()) {
        if (ts.isIdentifier(prm.name) && prm.name.text === name) return { param: { fn: p, index } };
        if (ts.isObjectBindingPattern(prm.name)) {
          for (const el of prm.name.elements) {
            if (ts.isIdentifier(el.name) && el.name.text === name) {
              const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : name;
              return { param: { fn: p, index, prop } };
            }
          }
        }
      }
    }
  }
  return {};
}

function callsOf(sf: ts.SourceFile, fn: string): ts.CallExpression[] {
  const out: ts.CallExpression[] = [];
  const visit = (x: ts.Node) => {
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === fn) out.push(x);
    ts.forEachChild(x, visit);
  };
  visit(sf);
  return out;
}

function localFunction(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (x: ts.Node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(x) && x.name?.text === name) { found = x; return; }
    if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && x.name.text === name && x.initializer) { found = x; return; }
    ts.forEachChild(x, visit);
  };
  visit(sf);
  return found;
}

function classify(file: string, sf: ts.SourceFile, e: ts.Expression, depth = 0): Verdict {
  if (depth > 12) return { kind: "unknown", why: "trace too deep" };
  let x: ts.Expression = e;
  while (ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)
    || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  if (ts.isCallExpression(x)) {
    if (readsTheOneSet(x) && (ts.isIdentifier(x.expression) || (ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "ownAddresses"))) {
      return { kind: "fed", why: "the one set's read" };
    }
    if (ts.isPropertyAccessExpression(x.expression) && ["map", "filter", "slice"].includes(x.expression.name.text)) {
      return classify(file, sf, x.expression.expression, depth + 1);
    }
    if (ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === "from" && x.arguments[0]
      && ts.isIdentifier(x.expression.expression) && x.expression.expression.text === "Array") {
      return classify(file, sf, x.arguments[0], depth + 1);
    }
    if (ts.isIdentifier(x.expression)) {
      const f = localFunction(sf, x.expression.text);
      if (f && readsTheOneSet(f)) return { kind: "fed", why: `${x.expression.text} reads the one set` };
      if (f && buildsFromMailboxRows(f)) return { kind: "built", why: `${x.expression.text} selects mailbox rows itself` };
    }
    if (buildsFromMailboxRows(x)) return { kind: "built", why: "selects mailbox rows itself" };
    return { kind: "unknown", why: `a call the census cannot follow: ${x.getText(sf).slice(0, 60)}` };
  }
  if (ts.isNewExpression(x) && x.arguments?.[0]) return classify(file, sf, x.arguments[0], depth + 1);
  if (ts.isArrayLiteralExpression(x) && x.elements.length === 1 && ts.isSpreadElement(x.elements[0]!)) {
    return classify(file, sf, x.elements[0].expression, depth + 1);
  }
  if (ts.isBinaryExpression(x) && (x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || x.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    const a = classify(file, sf, x.left, depth + 1);
    const b = classify(file, sf, x.right, depth + 1);
    if (a.kind !== "fed") return a;
    if (b.kind !== "fed") return b;
    const across = a.across ?? b.across;
    return { ...b, ...(across === undefined ? {} : { across }) };
  }
  if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression)) {
    const key = `${file}#${fnName(x)}:${x.getText(sf)}`;
    const feeder = FED_ACROSS[key];
    if (!feeder) return { kind: "unknown", why: `a property the census cannot follow: ${key}` };
    const fsf = parse(feeder.file, readFileSync(resolve(ROOT, feeder.file), "utf8"));
    const f = localFunction(fsf, feeder.fn);
    return f && readsTheOneSet(f) ? { kind: "fed", why: `fed by ${feeder.file}#${feeder.fn}`, across: key }
      : { kind: "unknown", why: `${feeder.file}#${feeder.fn} does not read the one set`, across: key };
  }
  if (ts.isIdentifier(x)) {
    const b = bindingOf(x.text, x);
    if (b.decl?.initializer) return classify(file, sf, b.decl.initializer, depth + 1);
    if (b.param) {
      const name = b.param.fn.name && ts.isIdentifier(b.param.fn.name) ? b.param.fn.name.text
        : ts.isVariableDeclaration(b.param.fn.parent) && ts.isIdentifier(b.param.fn.parent.name) ? b.param.fn.parent.name.text : null;
      const calls = name ? callsOf(sf, name) : [];
      if (calls.length === 0) return { kind: "unknown", why: `parameter ${x.text} of a function no call in this file feeds` };
      for (const c of calls) {
        let arg: ts.Expression | undefined = c.arguments[b.param.index];
        if (arg && b.param.prop && ts.isObjectLiteralExpression(arg)) {
          const pa = arg.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === b.param!.prop);
          arg = pa && ts.isPropertyAssignment(pa) ? pa.initializer : pa && ts.isShorthandPropertyAssignment(pa) ? pa.name : undefined;
        }
        if (!arg) return { kind: "unknown", why: `a call of ${name} passes no ${x.text}` };
        const v = classify(file, sf, arg, depth + 1);
        if (v.kind !== "fed") return v;
      }
      return { kind: "fed", why: `every call of ${name} feeds the one set` };
    }
    return { kind: "unknown", why: `${x.text} has no binding the census can see` };
  }
  return { kind: "unknown", why: `an expression the census cannot follow: ${x.getText(sf).slice(0, 60)}` };
}

/** Every `evaluateRules` call in a source, with what its `ownAddresses` reads. */
export function routerCalls(file: string, text: string): Array<{ at: string; verdict: Verdict }> {
  const sf = parse(file, text);
  const out: Array<{ at: string; verdict: Verdict }> = [];
  const visit = (x: ts.Node) => {
    if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "evaluateRules") {
      const at = `${file}:${sf.getLineAndCharacterOfPosition(x.getStart(sf)).line + 1}#${fnName(x)}`;
      const arg = x.arguments[0];
      const prop = arg && ts.isObjectLiteralExpression(arg)
        ? arg.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === "ownAddresses") : undefined;
      const value = prop && ts.isPropertyAssignment(prop) ? prop.initializer : prop && ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
      out.push({ at, verdict: value ? classify(file, sf, value) : { kind: "unknown", why: "no ownAddresses argument" } });
    }
    ts.forEachChild(x, visit);
  };
  visit(sf);
  return out;
}

/** Every variable named for an own set whose value traces to mailbox rows read here, as `file#function`. */
export function ownSetBuilders(file: string, text: string): string[] {
  if (file === ONE_SET_HOME) return [];
  const sf = parse(file, text);
  const out = new Set<string>();
  const visit = (x: ts.Node) => {
    if (ts.isVariableDeclaration(x) && ts.isIdentifier(x.name) && /own|self/i.test(x.name.text) && x.initializer
      && (buildsFromMailboxRows(x.initializer) || classify(file, sf, x.initializer).kind === "built")) out.add(`${file}#${fnName(x)}`);
    ts.forEachChild(x, visit);
  };
  visit(sf);
  return [...out];
}

const corpus = () => sourceFiles().map((f) => ({ f, text: readFileSync(resolve(ROOT, f), "utf8") }));

describe("the router reads one own-address set", () => {
  it("every evaluateRules call hands it the one set", () => {
    const calls = corpus().flatMap(({ f, text }) => routerCalls(f, text));
    expect(calls.length, "the census found no evaluateRules call: it would pass for nothing").toBeGreaterThan(4);
    const red = calls.filter((c) => c.verdict.kind !== "fed").map((c) => `${c.at}: ${c.verdict.kind} — ${c.verdict.why}`);
    expect(red, "a router caller builds or receives its own set: read it through readOwnAddresses").toEqual([]);
  });

  it("no module builds a second own set from mailbox rows but the named wider ones", () => {
    const builders = corpus().flatMap(({ f, text }) => ownSetBuilders(f, text));
    expect(builders.filter((b) => WIDER[b] === undefined), "a second own set: read readOwnAddresses, or name it in WIDER").toEqual([]);
    expect(Object.keys(WIDER).filter((k) => !builders.includes(k)), "a WIDER entry that no longer builds a set").toEqual([]);
  });

  it("every FED_ACROSS entry is a property a router call still reads, and its feeder is the only one", () => {
    const files = corpus();
    const used = new Set(files.flatMap(({ f, text }) => routerCalls(f, text)).map((c) => c.verdict.across).filter(Boolean));
    expect(Object.keys(FED_ACROSS).filter((k) => !used.has(k)), "a stale FED_ACROSS entry").toEqual([]);
    // No other caller hands the plan its own set: a planChange call naming ownAddresses is the feeder's.
    const feeders = new Set(Object.values(FED_ACROSS).map((v) => v.file));
    const passing = files.flatMap(({ f, text }) => {
      const sf = parse(f, text);
      const hits: string[] = [];
      const visit = (x: ts.Node) => {
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === "planChange"
          && x.arguments[1] && /\bownAddresses\b/.test(x.arguments[1].getText(sf))) hits.push(f);
        ts.forEachChild(x, visit);
      };
      visit(sf);
      return hits;
    });
    expect(passing.length, "no planChange call passes an own set: the feeder check would pass for nothing").toBeGreaterThan(0);
    expect(passing.filter((f) => !feeders.has(f)), "a planChange caller passes its own set").toEqual([]);
  });

  it("the one set's read is the one definition, and the repo's door is that read", () => {
    const own = readFileSync(resolve(ROOT, ONE_SET_HOME), "utf8");
    expect(withoutComments(own)).toMatch(/readOwnAddresses[\s\S]*mailboxCountsAsOwnSql\(mailboxes\)/);
    const repo = parse("drizzle-repo.ts", readFileSync(resolve(ROOT, "packages/core/src/adapters/drizzle-repo.ts"), "utf8"));
    let door: ts.Node | null = null;
    const visit = (x: ts.Node) => {
      if (ts.isMethodDeclaration(x) && x.name && ts.isIdentifier(x.name) && x.name.text === "ownAddresses") door = x;
      ts.forEachChild(x, visit);
    };
    visit(repo);
    expect(door && readsTheOneSet(door), "DrizzleRepo.ownAddresses no longer reads readOwnAddresses").toBe(true);
  });

  it("CONTROL: a planted caller that builds its own set reads red in both arms; one that reads the one set is admitted", () => {
    const planted = `
      import { mailboxes, readOwnAddresses } from "@trafficflow/db";
      export async function badPass(tx: Tx, accountId: string) {
        const ownRows = await tx.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
        const own = new Set(ownRows.map((r) => r.address.toLowerCase()));
        return evaluateRules({ msg, rules: [], knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, ownAddresses: own, auth: "unavailable", ohboxPolicy, identity: null });
      }
      function gate(own: ReadonlySet<string>) {
        return evaluateRules({ msg, rules: [], knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, ownAddresses: own, auth: "unavailable", ohboxPolicy, identity: null });
      }
      export async function goodPass(tx: Tx, accountId: string) {
        const ownSet = new Set([...await readOwnAddresses(tx, accountId)]);
        return gate(ownSet);
      }`;
    const calls = routerCalls("planted.ts", planted);
    expect(calls.map((c) => `${c.at.split("#")[1]}:${c.verdict.kind}`)).toEqual(["badPass:built", "gate:fed"]);
    expect(ownSetBuilders("planted.ts", planted)).toEqual(["planted.ts#badPass"]);
    const mixed = `${planted}
      export async function laterPass(tx: Tx, accountId: string) {
        const roster = await tx.select({ address: mailboxes.address }).from(mailboxes);
        const ownList = roster.map((r) => r.address);
        return gate(new Set(ownList));
      }`;
    expect(routerCalls("planted.ts", mixed).map((c) => c.verdict.kind)).toEqual(["built", "built"]);
    expect(ownSetBuilders("planted.ts", mixed)).toEqual(["planted.ts#badPass", "planted.ts#laterPass"]);
  });
});
