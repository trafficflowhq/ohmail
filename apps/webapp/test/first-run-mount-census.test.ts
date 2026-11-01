import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { SHELL_DIR } from "./source-anchor.js";

/**
 * ═══ THE MOUNT HANDS THE STAGE THIS MAILBOX'S FACTS ════════════════════════════════════════
 *
 * The stage's own cases prove what it does with what it is given: a `subjectVanished` run renders
 * a refusal, per-mailbox counters print per-mailbox numbers, an `accountOrganizer` makes the door
 * say what the connection will be. None of them can see whether the SHELL passes any of it — and
 * the whole class of defect this lane closes lives at that seam, where the values were composed
 * over the install while the screen they reached named one mailbox.
 *
 * So this reads the one `<FirstRun …>` element out of `AppShell.tsx` as an AST and asks four
 * questions of it. Every arm runs over a DOCTORED copy as well as the real source, because a
 * reader that finds nothing answers every question with a pass — the measured failure the
 * `source-anchor` helper documents at length.
 */

const SHELL = resolve(process.cwd(), SHELL_DIR, "AppShell.tsx");

/** The props the mount owes the stage, and what each one stops being wrong about. */
const OWED = [
  /* Without it the stage cannot tell a row that LEFT from an install that never had one, and the
     re-run falls through to a connect form whose mode reconfigures the install. */
  "subjectVanished",
  /* The one state the connect form can read about a mailbox that does not exist yet. */
  "accountOrganizer",
  /* The counters and the summary's two rows. */
  "pull",
  /* The guided decision's sender. */
  "decide",
  /* The pull held open until the store has answered the Screener's queue since the import ended. */
  "queueSettling",
  /* The store re-asked while the pull waits for the senders the run's own Agree will move. */
  "rereadQueue",
] as const;

function mountProps(source: string): { names: string[]; text: string } {
  const file = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.JsxOpeningLikeElement | undefined;
  const walk = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
        && ts.isIdentifier(node.tagName) && node.tagName.text === "FirstRun") {
      if (found) throw new Error("two FirstRun mounts — this census reads one");
      found = node;
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  if (!found) throw new Error("no <FirstRun> element in AppShell.tsx — stale census, not a pass");
  const names = found.attributes.properties.flatMap((p) => (
    ts.isJsxAttribute(p) && ts.isIdentifier(p.name) ? [p.name.text] : []
  ));
  return { names, text: found.getText(file) };
}

/** Does the file CALL this function — a call expression, never a mention. */
function calls(source: string, fn: string): boolean {
  const file = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let hit = false;
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fn) {
      hit = true;
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return hit;
}

/** How many arguments each call of this function passes, in source order. */
function argCounts(source: string, fn: string): number[] {
  const file = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: number[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fn) {
      out.push(node.arguments.length);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return out;
}

/** The `many` property's initializer in the decide subject `firstRunDecide` returns, or null. */
function decideMany(source: string): string | null {
  const file = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let decl: ts.VariableDeclaration | undefined;
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "firstRunDecide") decl = node;
    ts.forEachChild(node, walk);
  };
  walk(file);
  if (!decl) throw new Error("no firstRunDecide in AppShell.tsx — stale census, not a pass");
  let init: string | null = null;
  const find = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
      for (const p of node.expression.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "many") init = p.initializer.getText(file);
      }
    }
    ts.forEachChild(node, find);
  };
  find(decl);
  return init;
}

const real = readFileSync(SHELL, "utf8");

describe("AppShell's first-run mount", () => {
  it("carries every prop the stage needs to be about one mailbox", () => {
    const { names } = mountProps(real);
    for (const prop of OWED) expect(names, `the mount does not pass ${prop}`).toContain(prop);
  });

  it("DOCTORED CONTROL — a mount missing one of them is read as missing", () => {
    for (const prop of OWED) {
      const doctored = real.replace(new RegExp(`\\n\\s*${prop}=\\{`), "\n          xRemoved={");
      expect(doctored, `${prop} was not doctored — the control measures nothing`).not.toBe(real);
      expect(mountProps(doctored).names).not.toContain(prop);
    }
  });

  it("resolves the subject and the counts through the module that holds their rules", () => {
    expect(calls(real, "firstRunSubject"), "the shell resolves the run's mailbox inline again").toBe(true);
    expect(calls(real, "firstRunCounts"), "the counters are composed inline again").toBe(true);
    expect(calls(real, "screenerForMailbox"), "the guided queue is the install's again").toBe(true);
    expect(calls(real, "accountOrganizer")).toBe(true);
    expect(calls(real, "useFirstRunQueueSettle"), "the stage's queue hold is never armed").toBe(true);
  });

  it("DOCTORED CONTROL — a call reduced to a mention is not read as a call", () => {
    const doctored = real.replace("firstRunSubject(liveFacts,", "firstRunSubject; void (liveFacts,");
    expect(doctored).not.toBe(real);
    expect(calls(doctored, "firstRunSubject")).toBe(false);
  });

  it("the counters are not composed over the whole mirror at the mount", () => {
    const { text } = mountProps(real);
    /* `mirroredCount` is the mirror's whole row count and `history.length` the whole History
       list; both stood in `pull` and both were true about the install rather than about the
       mailbox the screen names. */
    expect(text, "the mount composes the counters over the install again").not.toContain("mirroredCount");
    expect(text).not.toContain("history.length");
  });

  it("DOCTORED CONTROL — the install-wide composition IS read when it is there", () => {
    const doctored = real.replace(
      "            ...firstRunPull,",
      "            screened: Math.max(0, mirroredCount - history.length),\n            history: history.length,",
    );
    expect(doctored, "the pull spread was not doctored").not.toBe(real);
    expect(mountProps(doctored).text).toContain("mirroredCount");
  });

  it("the two counters are this device's two partitions — no store total in their place", () => {
    /* A store total as the History figure counts every message the account owns, the screened
       ones included: the pair added to more mail than the mailbox holds. */
    expect(argCounts(real, "firstRunCounts"), "the counters take a store total again").toEqual([3]);
  });

  it("DOCTORED CONTROL — a fourth argument is read", () => {
    const doctored = real.replace("history, firstRunMailbox.id)", "history, firstRunMailbox.id, storeTotal)");
    expect(doctored, "the counters' call was not doctored").not.toBe(real);
    expect(argCounts(doctored, "firstRunCounts")).toEqual([4]);
  });

  it("the decide subject says whether the install has several mailboxes, by `firstRunQueue`'s rule (R20-03)", () => {
    expect(decideMany(real), "the decide step cannot tell an added mailbox from a single one").toBe("(liveFacts?.length ?? 0) > 1");
  });

  it("DOCTORED CONTROL — a subject without `many` is read as without it", () => {
    const doctored = real.replace(/ many: \(liveFacts\?\.length \?\? 0\) > 1,/, "");
    expect(doctored, "`many` was not doctored").not.toBe(real);
    expect(decideMany(doctored)).toBeNull();
  });
});
