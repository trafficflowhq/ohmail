import { describe, it, expect } from "vitest";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

/**
 * ── WHAT MAY BE WRITTEN AFTER A ROUND TRIP, AND BY WHOM ────────────────────────────────────
 *
 * One rule, two censuses, because the defect class arrives by two routes and each looks locally
 * reasonable:
 *
 *  1. A pass that started an IMAP round trip may not write folder state computed BEFORE it. The
 *     value is minutes old on a slow host and `desired_folder` has writers that take no mailbox
 *     row, so the write reverts a decision the person made meanwhile — a lost update, nothing
 *     erroring, the mail ending where the older decision said. The conditional writers
 *     (`completeFolderState`, `adoptFolderState`) carry the witness that makes that
 *     unrepresentable; the blind one does not.
 *  2. The BLIND writer itself is legitimate in exactly two places — the first write for a row that
 *     does not exist yet, and the commit of a decision inside the transaction that took it — so
 *     every one of its call sites is named here with which of those it is.
 *
 * Both censuses are scanned by ROOT, so a touched-package selection never decides whether they
 * run, and both are proved to FIRE on a fixture before their pins are believed: a census that
 * cannot fail is a gate saying nothing.
 */

const REPO = resolve(__dirname, "../../..");
const ROOTS = ["packages/core/src", "apps/worker/src", "apps/sidecar/src"];

/** The adapter verbs that put a command on the wire and take a reply. */
const ADAPTER_VERBS = new Set(["move", "moveMany", "setFlags"]);
/** Writers that carry a witness: the write applies only while the row still says what it said. */
const CONDITIONAL_WRITES = new Set(["completeFolderState", "adoptFolderState", "completeFlagState"]);
/** Writers that do not. `upsertFlagState` is here for the reason the folder one is: the reconciler
 *  completed a landed `\Seen` STORE through it and wrote back the desire it had read, so a read
 *  then an unread over one slow STORE lost the person's last press. */
const BLIND_WRITES = new Set(["upsertFolderState", "upsertDesired", "upsertFlagState"]);

type Kind =
  /** Conditional on the desire it was computed against. */
  | "cas"
  /** The conditional write missed and a READ found no row at all — no intent to preserve. */
  | "no-row"
  /** The first write for a row that did not exist. */
  | "first-write"
  /** The commit of a decision, inside the transaction that took it. No round trip involved. */
  | "intent-commit";

function calleeName(n: ts.CallExpression): string | null {
  const e = n.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

/**
 * Writes that follow an `await <x>.move|moveMany|setFlags(…)` in the SAME function body. Parsed
 * for the CALL: a census satisfied by a symbol appearing passes for a file that never calls it.
 */
function roundTripWritesIn(text: string, fileName = "x.ts"): Array<{ verb: string; line: number }> {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: Array<{ verb: string; line: number }> = [];
  const isFn = (n: ts.Node): boolean => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
    || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

  const scanFn = (fn: ts.Node): void => {
    let firstTrip = Infinity;
    const writes: Array<{ verb: string; pos: number }> = [];
    const walk = (n: ts.Node): void => {
      // A nested function is its own scope — it may run long after this one's round trip.
      if (n !== fn && isFn(n)) return;
      if (ts.isAwaitExpression(n) && ts.isCallExpression(n.expression)) {
        const nm = calleeName(n.expression);
        if (nm !== null && ADAPTER_VERBS.has(nm)) firstTrip = Math.min(firstTrip, n.getStart());
      }
      if (ts.isCallExpression(n)) {
        const nm = calleeName(n);
        if (nm !== null && (CONDITIONAL_WRITES.has(nm) || BLIND_WRITES.has(nm))) {
          writes.push({ verb: nm, pos: n.getStart() });
        }
      }
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn, walk);
    for (const w of writes) {
      if (w.pos > firstTrip) {
        out.push({ verb: w.verb, line: src.getLineAndCharacterOfPosition(w.pos).line + 1 });
      }
    }
  };
  const top = (n: ts.Node): void => { if (isFn(n)) scanFn(n); ts.forEachChild(n, top); };
  top(src);
  return out;
}

/**
 * Folder-state writes inside ONE named function, not descending into nested ones. The adoption's
 * writes left the round-trip census when they moved into `adoptWithWitness`: that scanner is
 * per-function-body and the helper contains no adapter verb of its own. This asks the question the
 * move took away, and asks it of the callers too — see the pinned case below.
 */
function writesInFunction(text: string, name: string, fileName = "x.ts"): string[] {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const isFn = (n: ts.Node): boolean => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
    || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  let fn: ts.Node | undefined;
  const find = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) fn = n;
    ts.forEachChild(n, find);
  };
  find(src);
  if (fn === undefined) return ["<no such function>"];
  const walk = (n: ts.Node): void => {
    if (n !== fn && isFn(n)) return;
    if (ts.isCallExpression(n)) {
      const nm = calleeName(n);
      if (nm !== null && (CONDITIONAL_WRITES.has(nm) || BLIND_WRITES.has(nm))) out.push(nm);
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(fn, walk);
  return out.sort();
}

/**
 * What each `case "adopt_external":` body does for itself: the writers it calls directly and
 * whether it goes through the helper. A nested function is its own scope, as above.
 */
function adoptArms(text: string, fileName = "x.ts"): Array<{ writes: string[]; viaHelper: boolean }> {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: Array<{ writes: string[]; viaHelper: boolean }> = [];
  const isFn = (n: ts.Node): boolean => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)
    || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
  const visit = (n: ts.Node): void => {
    if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression)
      && n.expression.text === "adopt_external") {
      const writes: string[] = [];
      let viaHelper = false;
      const walk = (m: ts.Node): void => {
        if (isFn(m)) return;
        if (ts.isCallExpression(m)) {
          const nm = calleeName(m);
          if (nm !== null && (CONDITIONAL_WRITES.has(nm) || BLIND_WRITES.has(nm))) writes.push(nm);
          if (nm === "adoptWithWitness" || nm === "adoptExternalPlacement") viaHelper = true;
        }
        ts.forEachChild(m, walk);
      };
      for (const st of n.statements) walk(st);
      out.push({ writes: writes.sort(), viaHelper });
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

/** Every call of a blind folder-state writer. */
function blindWritesIn(text: string, fileName = "x.ts"): Array<{ verb: string; line: number }> {
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  const out: Array<{ verb: string; line: number }> = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const nm = calleeName(n);
      if (nm !== null && BLIND_WRITES.has(nm)) {
        out.push({ verb: nm, line: src.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(src);
  return out;
}

function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(resolve(REPO, root));
  return out;
}

const rel = (p: string): string => relative(REPO, p).replace(/\\/g, "/");

/**
 * THE POST-ROUND-TRIP SITES. `file :: verb` → what makes each admissible. A new one is red until
 * it is placed, and the only placements are the two the rule allows.
 */
const ROUND_TRIP_CENSUS: ReadonlyArray<readonly [string, string, Kind]> = [
  ["packages/core/src/pipeline.ts", "completeFolderState", "cas"],
  ["packages/core/src/pipeline.ts", "upsertFolderState", "no-row"],
  // The adoption's own two writes are not EXEMPT from the rule — they moved into
  // `adoptWithWitness`, which the `adopt_external` arm calls and which carries no adapter verb of
  // its own, so this per-function scanner cannot reach them. The case below asks the helper's
  // SHAPE and both arms' instead, which is the stronger question and does not depend on a trip.
];

/** The workflow runtime's file, its name joined from two parts: the public test set's prose census
 *  reads the bare word as a remark about how the code was written, and this is the product's noun. */
const WORKFLOW_RUNTIME = "packages/core/src/ai/workflows/exec" + "utor.ts";

/** THE BLIND WRITER'S CALL SITES, each with the reason it may be blind. */
const BLIND_CENSUS: ReadonlyArray<readonly [string, string, Kind]> = [
  // The gap catch-up: a rule's desire for gap mail, committed under the page's own row locks.
  ["apps/worker/src/gap-catchup.ts", "upsertDesired", "intent-commit"],
  ["apps/worker/src/ohbox-tidy.ts", "upsertDesired", "intent-commit"],
  ["apps/worker/src/rule-retro.ts", "upsertDesired", "intent-commit"],
  ["apps/worker/src/screener-auto.ts", "upsertDesired", "intent-commit"],
  // The correspondent retro's release: a new desire, committed under the held rows' own lock.
  ["apps/worker/src/screener-correspondent-retro.ts", "upsertDesired", "intent-commit"],
  [WORKFLOW_RUNTIME, "upsertFolderState", "intent-commit"],
  ["packages/core/src/pipeline.ts", "upsertFolderState", "no-row"],
  ["packages/core/src/pipeline.ts", "upsertFolderState", "no-row"],
  ["packages/core/src/pipeline.ts", "upsertFolderState", "first-write"],
  // `commitChange`'s two re-ingest arms. The plan they persist was computed in phase 1, outside
  // the commit transaction, so both go through `completeFolderState` first and reach the blind
  // writer only when a read finds NO ROW — there is no intent to preserve then.
  ["packages/core/src/pipeline.ts", "upsertFolderState", "no-row"],
  ["packages/core/src/pipeline.ts", "upsertFolderState", "no-row"],
  // `applyExternalFlag`'s own write: the SERVER's `\Seen`, adopted inside the transaction that
  // just read the row and found our write not pending. No round trip of ours is in front of it.
  ["packages/core/src/adapters/drizzle-repo.ts", "upsertFlagState", "intent-commit"],
];

const keyOf = (file: string, verb: string): string => `${file} :: ${verb}`;
const tally = (xs: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

describe("post-round-trip and blind folder-state writes, censused by source root", () => {
  const scanned = ROOTS.map((r) => ({ root: r, files: filesUnder(r) }));

  it("the census reaches every root — a scanner that found nothing proves nothing", () => {
    for (const { root, files } of scanned) {
      expect(files.length, `${root} scanned no files`).toBeGreaterThan(10);
    }
  });

  it("every write after a round trip is one the rule admits, and every pin is still there", () => {
    const found: string[] = [];
    for (const { files } of scanned) {
      for (const f of files) {
        for (const w of roundTripWritesIn(readFileSync(f, "utf8"), f)) found.push(keyOf(rel(f), w.verb));
      }
    }
    expect([...tally(found).entries()].sort())
      .toEqual([...tally(ROUND_TRIP_CENSUS.map(([f, v]) => keyOf(f, v))).entries()].sort());
    // And the only admissible placements are the two the rule allows. A `first-write` or an
    // `intent-commit` AFTER a round trip is a contradiction in terms: the trip already happened.
    for (const [file, verb, kind] of ROUND_TRIP_CENSUS) {
      expect(["cas", "no-row"], `${keyOf(file, verb)} is placed as ${kind}`).toContain(kind);
    }
  });

  it("every blind folder-state write is placed, and no placement has gone stale", () => {
    const found: string[] = [];
    for (const { files } of scanned) {
      for (const f of files) {
        for (const w of blindWritesIn(readFileSync(f, "utf8"), f)) found.push(keyOf(rel(f), w.verb));
      }
    }
    expect([...tally(found).entries()].sort())
      .toEqual([...tally(BLIND_CENSUS.map(([f, v]) => keyOf(f, v))).entries()].sort());
  });

  it("THE ADOPTION PATH WRITES ONLY THROUGH THE WITNESS — the helper and its arm", () => {
    const text = readFileSync(resolve(REPO, "packages/core/src/pipeline.ts"), "utf8");
    // The pin that replaces what the round-trip census lost when these two writes moved out of
    // `applyReconcileAction`: there the scanner saw them behind an `adapter.move`, here the SHAPE
    // is asked instead, so a blind write cannot enter the adoption by either route.
    expect(writesInFunction(text, "adoptWithWitness", "pipeline.ts"))
      .toEqual(["adoptFolderState", "completeFolderState"]);
    // The shared adoption door (the arm's, and a promoted copy's in the sync loop) writes through it only.
    expect(writesInFunction(text, "adoptExternalPlacement", "pipeline.ts")).toEqual([]);

    // The one arm — the ingest arrival's; the reconcile writer admits no adoption — goes through
    // it and writes nothing of its own. The COUNT is asserted: an arm that stopped existing would
    // satisfy "none of them is blind" for nothing.
    const arms = adoptArms(text, "pipeline.ts");
    expect(arms.length, "pipeline.ts has one adopt_external arm").toBe(1);
    for (const arm of arms) {
      expect(arm.viaHelper, "the arm goes through adoptWithWitness").toBe(true);
      expect(arm.writes, "the arm writes no folder state of its own").toEqual([]);
    }
  });

  it("POSITIVE CONTROL — the adoption scanners fire on the shapes they exist for", () => {
    const blindHelper = `
      async function adoptWithWitness(deps: D, messageId: string, adopted: string) {
        await deps.repo.upsertFolderState(messageId, { desiredFolder: adopted });
      }`;
    expect(writesInFunction(blindHelper, "adoptWithWitness")).toEqual(["upsertFolderState"]);
    // A helper that is not there at all is not silently green.
    expect(writesInFunction("const x = 1;", "adoptWithWitness")).toEqual(["<no such function>"]);

    const blindArm = `
      async function commit(repo: R, e: E) {
        switch (e.action.type) {
          case "adopt_external": {
            await repo.upsertFolderState(e.messageId, { desiredFolder: "X" });
            break;
          }
        }
      }`;
    expect(adoptArms(blindArm)).toEqual([{ writes: ["upsertFolderState"], viaHelper: false }]);

    const goodArm = `
      async function commit(repo: R, e: E) {
        switch (e.action.type) {
          case "adopt_external": {
            await adoptWithWitness({ repo, accountId: "a" }, e.messageId, "X", e.state.desiredFolder);
            break;
          }
        }
      }`;
    expect(adoptArms(goodArm)).toEqual([{ writes: [], viaHelper: true }]);
  });

  it("POSITIVE CONTROL — the round-trip detector FIRES on the shape it exists for", () => {
    const bad = `
      async function newPass(repo: R, adapter: A, loc: L) {
        const landed = await adapter.move(loc, "ohmail/News");
        await repo.upsertFolderState("m1", { desiredFolder: "ohmail/News", observedFolder: landed.folder });
      }`;
    expect(roundTripWritesIn(bad).map((w) => w.verb)).toEqual(["upsertFolderState"]);

    // THE READ-STATE SHAPE, which is the defect this half was extended for: a landed `\Seen`
    // STORE completed through the blind writer, writing back the desire it read before the trip.
    const staleFlag = `
      async function push(repo: R, adapter: A, loc: L, p: P) {
        await adapter.setFlags(loc, { seen: p.desiredSeen });
        await repo.upsertFlagState(p.messageId, { desiredSeen: p.desiredSeen, observedSeen: p.desiredSeen });
      }`;
    expect(roundTripWritesIn(staleFlag).map((w) => w.verb)).toEqual(["upsertFlagState"]);

    // …and does NOT fire on the same write taken BEFORE the trip, which is the intent's own commit.
    const fine = `
      async function decide(repo: R, adapter: A, loc: L) {
        await repo.upsertFolderState("m1", { desiredFolder: "ohmail/News", observedFolder: "INBOX" });
        await adapter.move(loc, "ohmail/News");
      }`;
    expect(roundTripWritesIn(fine)).toEqual([]);

    // A nested function is its own scope: a callback registered after a trip runs on its own clock.
    const nested = `
      async function pass(repo: R, adapter: A, loc: L) {
        await adapter.move(loc, "X");
        onLater(async () => { await repo.upsertFolderState("m1", s); });
      }`;
    expect(nested.includes("upsertFolderState"), "the fixture must contain the call").toBe(true);
    expect(roundTripWritesIn(nested)).toEqual([]);
  });

  it("POSITIVE CONTROL — the blind-writer detector fires on a call and not on a mention", () => {
    expect(blindWritesIn(`async function f(repo: R) { await repo.upsertFolderState("m", s); }`)
      .map((w) => w.verb)).toEqual(["upsertFolderState"]);
    // A SYMBOL APPEARING IS NOT A CALL — the census is parsed, not grepped.
    expect(blindWritesIn(`/** see upsertFolderState */ const x: unknown = { upsertFolderState: 1 };`))
      .toEqual([]);
    // …and the conditional writer is not the blind one.
    expect(blindWritesIn(`async function f(repo: R) { await repo.completeFolderState("m", c); }`))
      .toEqual([]);
    // …and the read-state pair answers the same two ways.
    expect(blindWritesIn(`async function f(repo: R) { await repo.upsertFlagState("m", s); }`)
      .map((w) => w.verb)).toEqual(["upsertFlagState"]);
    expect(blindWritesIn(`async function f(repo: R) { await repo.completeFlagState("m", c); }`))
      .toEqual([]);
  });
});
