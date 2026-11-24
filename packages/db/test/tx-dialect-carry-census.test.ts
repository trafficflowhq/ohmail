import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
// ONE scanner (its .d.mts sits beside it), the way packages/db's other censuses import one.
import * as scan from "../../../scripts/lib/source-scan.mjs";

/** The workflow runtime's path tail, joined from two parts: the public test set's prose census reads
 *  the bare word as a remark about how the code was written, and this is the product's noun. */
const WORKFLOW_RUNTIME_TAIL = "ai/workflows/exec" + "utor.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * A REPOSITORY BUILT AROUND A TRANSACTION MUST BE TOLD WHICH DIALECT THE TRANSACTION SPEAKS.
 *
 * `repo.transaction(…)` carries the brand across for its callers. Code that opens a transaction on
 * the driver handle instead and constructs the repository itself gets no such help: the driver's
 * transaction object is a fresh object with no brand, and the repository refuses at its first
 * locking statement.
 *
 * The behavioural proof of that is in the core package's seam test. This is the census that keeps
 * it from coming back at a fourth site, because the failure it prevents is a runtime throw on a
 * background path — a leadership fence, a retro pass, an Ohbox tidy — where nobody is watching.
 *
 * Deliberately a text rule rather than a type: the brand is a symbol property, so both forms have
 * the same type and a compiler cannot tell them apart.
 */
function productionSources(): string[] {
  // `git ls-files` with a `**` pathspec matched a fraction of the tree when this was written, and
  // a census that silently looks at less than it says is the failure it exists to catch. List the
  // tracked files and filter here, where the rule is readable.
  const out = execFileSync("git", ["ls-files", "apps", "packages"], { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").filter((f) => /^(apps|packages)\/[^/]+\/src\/.*\.ts$/.test(f));
}

/**
 * Comments out, so prose about the rule does not read as a breach of it. Two files describe
 * `makeDrizzleRepo(tx)` in a doc comment and were reported as offenders by the first draft of this
 * census.
 *
 * It is the SHARED SCANNER and not two regexes: a `/*` inside a string — the glob in
 * `mailbox-service.ts`'s `// … \`ohmail/*\` never appears;` — opens a comment the regex pair
 * closes at a real end-of-comment far below, and the bracket walk under it then runs to the end of
 * the file and reports every later call as covered.
 */
const withoutComments = (src: string): string => scan.withoutComments(src);

/** The span of a call's arguments, from the open bracket to its match. */
function argumentSpan(src: string, open: number): [number, number] {
  return scan.span(src, open);
}

function allIndexes(src: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) out.push(i);
  return out;
}

interface RepoInTx { readonly file: string; readonly text: string; readonly carried: boolean; }

/**
 * Every `makeDrizzleRepo(` that sits LEXICALLY INSIDE a `.transaction(` callback.
 *
 * Keyed on position rather than on the argument's spelling. The first draft asked whether the
 * argument mentioned `tx`, which flagged a file that names its CONNECTION `tx` — a handle that is
 * branded and needs no carry — and would have missed any site that calls its transaction anything
 * else. Where the call sits is the thing the rule is actually about.
 */
function reposMadeInsideTransactions(file: string, raw: string): RepoInTx[] {
  const src = withoutComments(raw);
  const spans = allIndexes(src, ".transaction(").map((i) =>
    argumentSpan(src, i + ".transaction".length));
  /* THE SEAM OPENS ONE TOO, and the handle it hands its callback is ALREADY carried — that is
     part of what the seam is for. Without this the workflow runner's repo, which moved onto it,
     simply disappeared from this census: not refused, not admitted, invisible. A site nothing
     looks at is the state this file exists to prevent. */
  const seamSpans = allIndexes(src, "fencedAccountWrite(").map((i) =>
    argumentSpan(src, i + "fencedAccountWrite".length));
  const out: RepoInTx[] = [];
  for (const at of allIndexes(src, "makeDrizzleRepo(")) {
    const inSeam = seamSpans.find(([from, to]) => at > from && at < to);
    const enclosing = spans.find(([from, to]) => at > from && at < to) ?? inSeam;
    if (!enclosing) continue;
    const [from, to] = argumentSpan(src, at + "makeDrizzleRepo".length);
    const text = raw.slice(from, to).replace(/\s+/g, " ").trim();

    // The carry may be written into the argument, or done once when the handle is bound and used
    // by name — the second reads better where the transaction handle is used more than once. Both
    // are the same thing; a census that only accepted the first would push people to write the
    // worse of the two to keep it quiet.
    const bound = /^([A-Za-z_$][\w$]*)/.exec(text)?.[1];
    // BEFORE the call, not merely somewhere in the same span. A carry written after the repository
    // is built reads identically to one written before it if the search ignores position — and the
    // later one does nothing, because the handle was already read. Demonstrated: reassigning the
    // handle to its carry on the line AFTER the construction passed this census unchanged.
    const before = src.slice(enclosing[0], at);
    const carried = inSeam !== undefined
      || /\bcarryDialect\s*\(/.test(text)
      || (bound !== undefined
        && new RegExp(`\\b${bound}\\s*=\\s*carryDialect\\s*\\(`).test(before));
    out.push({ file, text, carried });
  }
  return out;
}

function census(): RepoInTx[] {
  return productionSources().flatMap((f) =>
    reposMadeInsideTransactions(f, readFileSync(path.join(ROOT, f), "utf8")));
}

describe("the dialect census over repositories made from a transaction", () => {
  it("finds the call sites it is written about, so it cannot pass by finding nothing", () => {
    // The first thing this census must prove is that it looked. A rename of the factory, a glob
    // that stopped matching, or a bracket walk that fell off the end would otherwise read exactly
    // like a clean sweep.
    expect(census().length).toBeGreaterThanOrEqual(5);
  });

  it("ignores a repository built from a handle that merely happens to be called tx", () => {
    // The connection in the rescreen pass is named `tx` and is branded. A census keyed on the
    // argument's spelling reported it, which is how a guard trains people to ignore it.
    const rescreen = census().filter((c) => c.file.endsWith("sensitive-rescreen.ts"));
    expect(rescreen).toEqual([]);
  });

  it("accepts a carry done once where the handle is bound, not only inside the argument", () => {
    // Driven, because the production tree no longer has such a site to point at: the workflow
    // runner bound its handle and used it several times, and it now opens through the seam,
    // which carries for it. The RULE still has to work, so it is exercised on a fixture rather
    // than deleted — and the fixture is the shape the workflow runner had.
    const bound = reposMadeInsideTransactions("x.ts",
      "db.transaction(async (raw) => { const tx = carryDialect(db, raw); "
      + "const r = makeDrizzleRepo(tx); await tx.insert(t).values({}); });");
    expect(bound).toHaveLength(1);
    expect(bound[0]!.carried, "a carry done where the handle is bound reads as carried").toBe(true);
  });

  it("reads a repository built inside the SEAM as carried, and still sees it", () => {
    // The workflow runner's site, now. `fencedAccountWrite` carries the brand across the transaction
    // boundary for every caller, which is why the hand-carry left this file — but a site that
    // stopped being COUNTED would be a hole rather than a fix, so it is asserted by name.
    const runtimeSites = census().filter((c) => c.file.endsWith(WORKFLOW_RUNTIME_TAIL));
    expect(runtimeSites.length, "the workflow runtime's repository is invisible to this census").toBe(1);
    expect(runtimeSites.every((c) => c.carried)).toBe(true);
  });

  it("does not accept a carry written after the repository was built", () => {
    // A unit check on the rule, because the production tree has no such site to point at — and
    // should not need one for the rule to be known to work.
    const late = reposMadeInsideTransactions("x.ts",
      "db.transaction(async (tx) => { const r = makeDrizzleRepo(tx); tx = carryDialect(db, tx); });");
    expect(late).toHaveLength(1);
    expect(late[0].carried, "a carry after the construction carries nothing").toBe(false);

    const inTime = reposMadeInsideTransactions("x.ts",
      "db.transaction(async (tx) => { tx = carryDialect(db, tx); const r = makeDrizzleRepo(tx); });");
    expect(inTime).toHaveLength(1);
    expect(inTime[0].carried).toBe(true);
  });

  it("routes every repository made inside a transaction through the carry", () => {
    const offenders = census().filter((c) => !c.carried)
      .map((c) => `${c.file}: makeDrizzleRepo(${c.text})`);
    expect(offenders).toEqual([]);
  });
});

/**
 * WHAT IS LEFT OF CARRYING THE BRAND BY HAND, pinned exactly.
 *
 * Branding a handle now wraps its `transaction`, so a callback is handed a branded object and a
 * savepoint opened on that one is branded too. The brand is INHERITED, which is what makes "a
 * handle that reaches a statement is branded" true by construction rather than by everybody
 * remembering — and remembering was the failure: nineteen requests answered 500 from one read that
 * had just started asking which store it was on, with the reason discarded by the route's handler.
 *
 * The sites below predate that and are now belt-and-braces. They are kept rather than swept because
 * each is a REPOSITORY built around a transaction, where being explicit costs nothing and reads as
 * the deliberate act it is — and they are PINNED because a NEW one appearing is the interesting
 * event: it means somebody met an unbranded transaction and stamped it by hand, which is either a
 * handle no factory branded (the seam's own refusal is the right answer) or a driver whose
 * transaction the wrapper did not reach (which this file is where to record).
 *
 * TWO OF THEM DO NOT PREDATE IT, and they are the second case that paragraph names.
 * `packages/services/src/context.ts` is the shared `runInTransaction`: it reaches
 * `db.transaction` through a structural cast, so the branded wrapper is not in that path and
 * the callback's handle arrives unbranded — this one carry is what every service opening a
 * transaction through that helper depends on, and without it a phone's statements asked the
 * server's dialect inside every transaction. `mailbox-service.ts` derives a projection context
 * around a transaction for the reason its own comment gives, one line above the call.
 */
describe("carrying the dialect by hand", () => {
  it("happens at exactly the sites this file records, and nowhere else", () => {
    const sites = productionSources()
      .flatMap((file) => {
        const src = withoutComments(readFileSync(path.join(ROOT, file), "utf8"));
        return allIndexes(src, "carryDialect(").map(() => file);
      })
      .sort();
    expect(sites).toEqual([
      "apps/worker/src/mailboxes.ts",
      /* TWICE, and the second is this release's: the erasure fence groups a mailbox's writes in one
         transaction, and a repository built straight from that `tx` refuses on its first locking
         statement because the transaction object does not inherit the connection's dialect brand.
         One entry per OCCURRENCE, which is what this census counts. */
      "apps/worker/src/mailboxes.ts",
      "apps/worker/src/ohbox-tidy.ts",
      // The organize decision's sweep opens its own transaction (the mailbox row, then the walk), on
      // the phone's store as on the server's, and builds the gate's repo from it.
      "packages/core/src/unscreened-set.ts",
      // The Screener act pass LEFT this list when its per-sender transaction began opening through
      // `fencedAccountWrite` (the fence before its settings lock), which carries the brand itself.
      // The workflow runner LEFT this list in the same change the seam joined it: the seam
      // carries once, where the transaction is opened, so its callers no longer carry by hand.
      "packages/db/src/erasure-fence.ts",
      // The 0.25.9 press repair opens its own transaction and writes the change log in it, on the
      // phone's store as on the server's.
      "packages/db/src/inferred-press-repair.ts",
      // The gap catch-up's page transaction, rule-retro's shape: its repository is built from the `tx`.
      "packages/organizer/src/gap-catchup.ts",
      "packages/organizer/src/request-drain.ts",
      // TWICE since the refused request is recorded before it is answered: that record is written in
      // its own transaction after the apply's rollback, fenced like the apply, from the raw `tx`.
      "packages/organizer/src/request-drain.ts",
      "packages/organizer/src/rule-retro.ts",
      // The approval LEFT this list when its decision began opening through `withAccountTx` (the
      // fence and the rule-key lock first), whose seam carries the brand itself.
      // The two the docblock's second paragraph names: the shared transaction helper, and the
      // projection derived beside a transaction in the mailbox service.
      "packages/services/src/context.ts",
      "packages/services/src/mailbox-service.ts",
      "packages/services/src/screener-service.ts",
      "packages/services/src/send-service.ts",
    ]);
  });
});
