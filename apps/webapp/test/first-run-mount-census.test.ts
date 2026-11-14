import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { sliceOfDeclaration } from "./source-anchor.js";

/*
 * A stage fixture can provide its own mailbox facts. These guards follow the
 * actual registration through the mail ground so an install-wide count cannot
 * pass by supplying a more accurate number in a fixture.
 */
const MODEL = "packages/app-logic/src/mailboxes/first-run";
const STAGE = "packages/app/src/mailboxes/first-run";
const read = (file: string): string => readFileSync(resolve(process.cwd(), file), "utf8");
const registration = read("packages/app/src/mail/stages.ts");
const seat = read(STAGE + "/Seat.ts");
const stage = read(STAGE + "/stage.tsx");
const live = read(MODEL + "/live.ts");
const actor = read(MODEL + "/use-first-run.ts");
const subject = read("packages/app-logic/src/mailboxes/connect/subject.ts");

function find<T extends ts.Node>(source: string, kind: (node: ts.Node) => node is T): T[] {
  const file = ts.createSourceFile("source.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: T[] = [];
  function visit(node: ts.Node): void {
    if (kind(node)) found.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function one<T>(items: T[], label: string): T {
  if (items.length !== 1) throw new Error("expected one " + label + ", found " + items.length);
  return items[0]!;
}

function calls(source: string, name: string): ts.CallExpression[] {
  return find(source, ts.isCallExpression).filter((call) => call.expression.getText() === name);
}

function callRecord(source: string, name: string): ts.ObjectLiteralExpression {
  const arg = one(calls(source, name), name + " call").arguments.find(ts.isObjectLiteralExpression);
  if (!arg) throw new Error(name + " no longer receives a fact record");
  return arg;
}

function resultRecord(source: string, name: string): ts.ObjectLiteralExpression {
  const result = one(find(source, ts.isArrowFunction).filter((fn) => fn.type?.getText() === name), name + " result");
  if (!ts.isParenthesizedExpression(result.body) || !ts.isObjectLiteralExpression(result.body.expression)) {
    throw new Error(name + " no longer returns a fact record");
  }
  return result.body.expression;
}

function fields(record: ts.ObjectLiteralExpression): string[] {
  return record.properties.flatMap((property) => property.name ? [property.name.getText()] : []);
}

const owed = [
  { source: actor, record: (source: string) => callRecord(source, "useCursor"), name: "vanished" },
  { source: live, record: (source: string) => resultRecord(source, "FirstRunGround"), name: "accountOrganizer" },
  { source: live, record: (source: string) => resultRecord(source, "FirstRunAbout"), name: "pull" },
  { source: actor, record: (source: string) => callRecord(source, "useDecide"), name: "sender" },
  { source: live, record: (source: string) => resultRecord(source, "FirstRunAbout"), name: "queueSettling" },
  { source: actor, record: (source: string) => callRecord(source, "useStageFacts"), name: "rereadQueue" },
];

function revise(source: string, search: string | RegExp, replacement: string): string {
  const changed = source.replace(search, replacement);
  expect(changed, "the control must change the source").not.toBe(source);
  return changed;
}

function decideMany(source: string): string | null {
  const sender = sliceOfDeclaration(source, "sender");
  const handsMany = find(sender, ts.isShorthandPropertyAssignment).some((prop) => prop.name.text === "many");
  if (!handsMany) return null;
  return one(find(source, ts.isVariableDeclaration).filter((decl) => decl.name.getText() === "many"), "mailbox count")
    .initializer?.getText() ?? null;
}

describe("AppShell's first-run mount", () => {
  it("carries every prop the stage needs to be about one mailbox", () => {
    expect(callRecord(registration, "firstRunStage").getText()).toContain("ground: useFirstRunSeat");
    expect(fields(callRecord(seat, "useFirstRunLive"))).toEqual(expect.arrayContaining(["how", "word"]));
    expect(fields(callRecord(stage, "useFirstRun"))).toEqual(expect.arrayContaining(["ground", "how", "word"]));
    expect(one(calls(actor, "ground.about"), "subject's ground read").arguments[0]?.getText()).toBe("mailboxId");
    for (const { source, record, name } of owed) expect(fields(record(source))).toContain(name);
  });

  it("DOCTORED CONTROL — a mount missing one of them is read as missing", () => {
    for (const { source, record, name } of owed) {
      const property = one(record(source).properties.filter((prop) => prop.name?.getText() === name), name);
      const key = property.name!;
      const changed = source.slice(0, key.getStart()) + "removedFact" + source.slice(key.end);
      expect(fields(record(changed))).not.toContain(name);
    }
  });

  it("resolves the subject and the counts through the module that holds their rules", () => {
    expect(calls(subject, "firstRunSubject")).toHaveLength(1);
    expect(calls(actor, "subjectOf")).toHaveLength(1);
    expect(calls(live, "subjectOf")).toHaveLength(1);
    expect(calls(live, "firstRunCounts")).toHaveLength(1);
    expect(calls(live, "screenerForMailbox")).toHaveLength(1);
    expect(calls(live, "accountOrganizer")).toHaveLength(1);
    expect(calls(live, "useFirstRunQueueSettle")).toHaveLength(1);
  });

  it("DOCTORED CONTROL — a call reduced to a mention is not read as a call", () => {
    const changed = revise(subject, "firstRunSubject(rows,", "(firstRunSubject, unrelated)(rows,");
    expect(calls(changed, "firstRunSubject")).toHaveLength(0);
  });

  it("the counters are not composed over the whole mirror at the mount", () => {
    const about = resultRecord(live, "FirstRunAbout").getText();
    expect(about).toContain("pull: { ...counts, pulled, whole }");
    expect(about).not.toContain("mirroredCount");
    expect(about).not.toContain("history.length");
  });

  it("DOCTORED CONTROL — the install-wide composition IS read when it is there", () => {
    const changed = revise(live, "...counts, pulled, whole", "screened: mirroredCount - history.length, pulled, whole");
    const about = resultRecord(changed, "FirstRunAbout").getText();
    expect(about).toContain("mirroredCount");
    expect(about).toContain("history.length");
  });

  it("the two counters are this device's two partitions — no store total in their place", () => {
    const { arguments: args } = one(calls(live, "firstRunCounts"), "firstRunCounts call");
    expect(args).toHaveLength(3);
    expect(args[1]?.getText()).toBe("history");
    expect(args[2]?.getText()).toBe("subjectId");
  });

  it("DOCTORED CONTROL — a fourth argument is read", () => {
    const changed = revise(live, "history, subjectId)", "history, subjectId, storeTotal)");
    expect(one(calls(changed, "firstRunCounts"), "firstRunCounts call").arguments).toHaveLength(4);
  });

  it("the decide subject says whether the install has several mailboxes, by `firstRunQueue`'s rule (R20-03)", () => {
    expect(decideMany(live)).toBe("(facts?.length ?? 0) > 1");
  });

  it("DOCTORED CONTROL — a subject without `many` is read as without it", () => {
    const sender = sliceOfDeclaration(live, "sender");
    const changed = revise(live, sender, revise(sender, /^\s+many,$/m, ""));
    expect(decideMany(changed)).toBeNull();
  });
});
